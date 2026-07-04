import path from "node:path";
import {
  type DirectoryNode,
  type FunctionNode,
  type Graph,
  GraphSchema,
  type ModuleNode,
  type Provenance,
  type Smell,
  type Summary,
  type Thresholds,
} from "../schema.js";
import { compareFlatSmells, smellsForFunction, smellsForModule } from "../smells/evaluate.js";
import { healthBand } from "../smells/health.js";
import { rankPlan } from "../smells/plan.js";
import { buildDirectories } from "./directories.js";
import { type EdgeResult, resolveEdges } from "./edges.js";
import { type DiscoveredFunction, discoverFunctions, isTestFile } from "./functions.js";
import { computeFunctionMetrics, moduleCommentLines, moduleLoc } from "./metrics.js";
import { type EdgeScope, type LoadedProject, toRelative } from "./project.js";

/**
 * assemble.ts — turn a loaded project into a schema-valid Graph (SPEC §3, §5).
 *
 * Two entry points share one builder:
 *  - `assembleGraph` (cheap pass): functions/modules/metrics + cheap-pass smells
 *    (incl. directory-sprawl) + ranking. The per-function `edges` block is `null`
 *    (edges not computed) and `importedBy` stays []. `provenance.pass = "cheap"`.
 *  - `assembleGraphWithEdges` (edge pass): same, but populates the `edges` block
 *    (calls/calledBy/callChainDepth) + `importedBy` from a resolved EdgeResult,
 *    runs the edge smells,
 *    and recomputes the Summary so fan-in/chain smells count and `--by impact`
 *    is meaningful. `provenance.pass = "edges"`.
 *
 * The assembled object is parsed through GraphSchema before return
 * (parse-don't-validate); the contract gates even our own assembly.
 */

/** Module smell weight (SPEC §5 worstFile): high=2, warn=1, summed. */
function smellWeight(smells: Smell[]): number {
  return smells.reduce((s, m) => s + (m.severity === "high" ? 2 : 1), 0);
}

/** Optional edge data threaded into the builder when the edge pass ran. */
type EdgeBundle = {
  result: EdgeResult;
  scope: EdgeScope;
  tsConfig: string;
};

/**
 * Build every FunctionNode (SPEC §5): per-function metrics, the one `edges`
 * block (null in the cheap pass, all-real in the edge pass — no half-populated
 * data), then attach smells AFTER edge fields land so fan-in / deep-call-chain
 * become live.
 */
function buildFunctionNodes(
  fns: DiscoveredFunction[],
  thresholds: Thresholds,
  edges: EdgeBundle | null,
): FunctionNode[] {
  return fns.map((d) => {
    const m = computeFunctionMetrics(d.node);
    const fn: FunctionNode = {
      id: d.id,
      name: d.name,
      kind: d.kind,
      file: d.file,
      startLine: d.startLine,
      endLine: d.endLine,
      loc: m.loc,
      commentLines: m.commentLines,
      nestingDepth: m.nestingDepth,
      complexity: m.complexity,
      isExported: d.isExported,
      isTest: d.isTest,
      edges: edges
        ? {
            calls: edges.result.callsById.get(d.id) ?? [],
            calledBy: edges.result.calledById.get(d.id) ?? [],
            callChainDepth: edges.result.chainDepthById.get(d.id) ?? 0,
          }
        : null,
      smells: [],
    };
    fn.smells = smellsForFunction(fn, thresholds);
    return fn;
  });
}

/**
 * Build every ModuleNode (SPEC §5), sorted by file. Imports come from the edge
 * result when the edge pass ran (importedBy too); otherwise they are read
 * syntactically and importedBy stays []. Module smells (big-file) attach here.
 */
function buildModuleNodes(
  loaded: LoadedProject,
  thresholds: Thresholds,
  edges: EdgeBundle | null,
  functions: FunctionNode[],
): ModuleNode[] {
  const { rootAbsolute, sourceFiles } = loaded;
  const idsByFile = new Map<string, string[]>();
  for (const f of functions) {
    const arr = idsByFile.get(f.file) ?? [];
    arr.push(f.id);
    idsByFile.set(f.file, arr);
  }

  const modules: ModuleNode[] = sourceFiles.map((sf) => {
    const file = toRelative(rootAbsolute, sf.getFilePath());
    const imports = edges
      ? (edges.result.importsByFile.get(file) ?? [])
      : // Dedup, not just sort: a file importing the same module twice (e.g.
        // `import {a}` + `import type {B}` from one specifier) must yield one
        // entry — SPEC §3 "arrays deduped". The edge pass dedups via
        // dedupSorted; the cheap pass mirrors it with a sorted Set.
        [
          ...new Set(
            sf
              .getImportDeclarations()
              .map((i) => i.getModuleSpecifierValue())
              .filter((v): v is string => typeof v === "string"),
          ),
        ].sort((a, b) => a.localeCompare(b));
    const functionIds = (idsByFile.get(file) ?? []).slice().sort((a, b) => a.localeCompare(b));
    const module: ModuleNode = {
      file,
      loc: moduleLoc(sf),
      commentLines: moduleCommentLines(sf),
      functionIds,
      imports,
      importedBy: edges ? (edges.result.importedByFile.get(file) ?? []) : [],
      isTest: isTestFile(file),
      smells: [],
    };
    module.smells = smellsForModule(module, thresholds);
    return module;
  });
  modules.sort((a, b) => a.file.localeCompare(b.file));
  return modules;
}

/** The flattened, sorted smell list + its count + high-severity count (SPEC §5). */
function collectSmells(
  functions: FunctionNode[],
  modules: ModuleNode[],
  directories: DirectoryNode[],
): { allSmells: Smell[]; smellCount: number; highSeverityCount: number } {
  const allSmells: Smell[] = [
    ...functions.flatMap((f) => f.smells),
    ...modules.flatMap((m) => m.smells),
    ...directories.flatMap((dir) => dir.smells),
  ].sort(compareFlatSmells);
  return {
    allSmells,
    smellCount: allSmells.length,
    highSeverityCount: allSmells.filter((s) => s.severity === "high").length,
  };
}

/**
 * The Summary block (SPEC §5): health band, counts, top targets, and the worst
 * file/function. A clean folder yields `null` worsts (honest states) — only
 * functions/files that carry real smell weight are surfaced.
 */
function buildSummary(
  functions: FunctionNode[],
  modules: ModuleNode[],
  smellCount: number,
  highSeverityCount: number,
  parseFailures: string[],
): Summary {
  const ranked = rankPlan(functions, "rot");
  const flagged = ranked.filter((r) => r.components.smells > 0);
  const topTargets = flagged.slice(0, 10);
  const worstFunction = flagged.length > 0 ? flagged[0].id : null;

  let worstFile: string | null = null;
  let worstWeight = 0;
  for (const m of modules) {
    const w = smellWeight(m.smells);
    if (w > worstWeight) {
      worstWeight = w;
      worstFile = m.file;
    }
  }

  return {
    health: healthBand({ smellCount, highSeverityCount, fileCount: modules.length }),
    fileCount: modules.length,
    functionCount: functions.length,
    smellCount,
    highSeverityCount,
    worstFile,
    worstFunction,
    topTargets,
    parseFailures,
  };
}

/**
 * The shared builder. `edges === null` → cheap pass; otherwise edge fields are
 * read from the bundle (keyed by FunctionNode.id / analyzed-root-relative file).
 *
 * `discovered` is the function enumeration over `loaded.sourceFiles`. The edge
 * path enumerates ONCE (to build the node→id map for edge resolution) and threads
 * the same list in here, so functions are never discovered twice; the cheap path
 * passes `null` and the builder enumerates itself.
 */
function build(
  loaded: LoadedProject,
  thresholds: Thresholds,
  edges: EdgeBundle | null,
  discovered: DiscoveredFunction[] | null,
): Graph {
  const { rootAbsolute, sourceFiles, parseFailures } = loaded;
  const root = path.relative(process.cwd(), rootAbsolute) || ".";

  const fns = discovered ?? discoverFunctions(rootAbsolute, sourceFiles).functions;
  const functions = buildFunctionNodes(fns, thresholds, edges);
  const modules = buildModuleNodes(loaded, thresholds, edges, functions);
  // Directories (SPEC §8-C4) run in BOTH passes — cheap-pass smell.
  const directories: DirectoryNode[] = buildDirectories(modules, thresholds);

  const { allSmells, smellCount, highSeverityCount } = collectSmells(
    functions,
    modules,
    directories,
  );
  const summary = buildSummary(functions, modules, smellCount, highSeverityCount, parseFailures);

  const provenance: Provenance = edges
    ? { pass: "edges", tsConfig: edges.tsConfig, scope: edges.scope }
    : { pass: "cheap" };

  const graph: Graph = {
    root,
    provenance,
    thresholds,
    summary,
    functions,
    modules,
    directories,
    smells: allSmells,
    stats: {
      fileCount: modules.length,
      functionCount: functions.length,
      totalLoc: modules.reduce((s, m) => s + m.loc, 0),
      totalCommentLines: modules.reduce((s, m) => s + m.commentLines, 0),
      smellCount,
      parseFailures,
    },
  };

  return GraphSchema.parse(graph);
}

/** Cheap pass (SPEC §3): no edges, directory-sprawl included. */
export function assembleGraph(loaded: LoadedProject, thresholds: Thresholds): Graph {
  return build(loaded, thresholds, null, null);
}

/**
 * Edge pass (SPEC §3, §8): enumerate functions ONCE against the edge-pass project
 * (a DIFFERENT Project instance, so a fresh node→id map), resolve edges, and
 * build with the SAME enumeration threaded in — the builder no longer re-runs
 * `discoverFunctions`, so there is one enumeration per run, not two.
 */
export function assembleGraphWithEdges(
  loaded: LoadedProject,
  thresholds: Thresholds,
  scope: EdgeScope,
  tsConfig: string,
): Graph {
  const { rootAbsolute, sourceFiles } = loaded;
  const { functions, nodeToId } = discoverFunctions(rootAbsolute, sourceFiles);
  const ids = functions.map((f) => f.id);
  const result = resolveEdges(rootAbsolute, sourceFiles, nodeToId, ids);
  return build(loaded, thresholds, { result, scope, tsConfig }, functions);
}
