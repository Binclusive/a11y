import type { FunctionNode, Graph, ModuleNode, PlanRow, Smell, Summary } from "../schema.js";
import { rankPlan } from "../smells/plan.js";

export type { Summary };

/**
 * html-model.ts -- the PURE projection from the agent-native `Graph` to the §4
 * view-model for the `--html` report (HTML-VIEW.md). No DOM, no I/O, fully
 * deterministic (sorted per SPEC §3). The HTML scaffold (html-template.ts) and
 * the CLI renderer (html.ts) consume what this builds; this file is the unit-
 * tested heart of the feature.
 */

// --- Severity ladder: the ONE color rule (HTML-VIEW §5). Single-sourced here ---
// none -> green, warn -> amber, high -> red. Reused by the treemap boxes, the
// graph nodes, and the header health chip (via html-template.ts).
export type Severity = "none" | "warn" | "high";

export const SEVERITY_COLOR: Record<Severity, string> = {
  none: "#2e9e57", // green
  warn: "#d99a1c", // amber
  high: "#d24545", // red
};

/** Rank severities so we can take the worst of a set (none < warn < high). */
const SEVERITY_RANK: Record<Severity, number> = { none: 0, warn: 1, high: 2 };

/** The worst severity across a set of smells: any high wins, then any warn, else none. */
function worstSeverity(smells: readonly Smell[]): Severity {
  let worst: Severity = "none";
  for (const smell of smells) {
    const sev: Severity = smell.severity === "high" ? "high" : "warn";
    if (SEVERITY_RANK[sev] > SEVERITY_RANK[worst]) worst = sev;
  }
  return worst;
}

/** Take the worse of two severities. */
function maxSeverity(a: Severity, b: Severity): Severity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

// --- §4 view-model ---

/** A node in the d3 treemap hierarchy: an interior dir (children) or a leaf file. */
export type TreemapNode = {
  name: string; // dir or file basename
  children?: TreemapNode[]; // interior dirs
  loc?: number; // leaf files: box size
  severity?: Severity; // leaf files: box color
  file?: string; // leaf files: full repo-relative path
  smellKinds?: string[]; // leaf files: tooltip (sorted, deduped)
};

/** A cytoscape node: a function included by the §3.2 rule (or a one-hop neighbor). */
export type GraphNode = {
  id: string;
  label: string;
  file: string;
  startLine: number;
  endLine: number;
  loc: number;
  complexity: number;
  fanIn: number;
  callChainDepth: number;
  severity: Severity;
  smellKinds: string[];
  hidden?: boolean; // a one-hop neighbor pulled in for context (not itself a target)
};

export type GraphEdge = { source: string; target: string };

export type HtmlModel = {
  summary: Summary;
  treemap: TreemapNode;
  graph: {
    nodes: GraphNode[];
    edges: GraphEdge[];
    hiddenCount: number; // "N functions hidden" note
  };
  plan: PlanRow[];
};

// --- Treemap (HTML-VIEW §3 hotspot) ---

/** Index functions by their file, so a module can fold in its functions' smells. */
function functionsByFile(graph: Graph): Map<string, FunctionNode[]> {
  const byFile = new Map<string, FunctionNode[]>();
  for (const fn of graph.functions) {
    const list = byFile.get(fn.file);
    if (list) list.push(fn);
    else byFile.set(fn.file, [fn]);
  }
  return byFile;
}

/**
 * A file's worst severity = the worst of its module smells AND the smells of
 * every function declared in it (HTML-VIEW §3: derive from module.smells + the
 * smells of functions in that file).
 */
function fileSeverity(module: ModuleNode, byFile: Map<string, FunctionNode[]>): Severity {
  let sev = worstSeverity(module.smells);
  for (const fn of byFile.get(module.file) ?? []) sev = maxSeverity(sev, worstSeverity(fn.smells));
  return sev;
}

/** A file's smell kinds (module + its functions), sorted + deduped for the tooltip. */
function fileSmellKinds(module: ModuleNode, byFile: Map<string, FunctionNode[]>): string[] {
  const kinds = new Set<string>();
  for (const smell of module.smells) kinds.add(smell.kind);
  for (const fn of byFile.get(module.file) ?? []) {
    for (const smell of fn.smells) kinds.add(smell.kind);
  }
  return [...kinds].sort();
}

/** A mutable interior node we fold files into while building the dir->file tree. */
type TreemapDir = { name: string; dirs: Map<string, TreemapDir>; leaves: TreemapNode[] };

function emptyDir(name: string): TreemapDir {
  return { name, dirs: new Map(), leaves: [] };
}

/** Freeze a mutable TreemapDir into the immutable, deterministically-sorted §4 shape. */
function finalizeDir(dir: TreemapDir): TreemapNode {
  const childDirs = [...dir.dirs.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(finalizeDir);
  const leaves = [...dir.leaves].sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
  return { name: dir.name, children: [...childDirs, ...leaves] };
}

/**
 * Build the dir->file treemap hierarchy. Each module is a leaf (size = loc, color
 * = worst file severity); the file path's directory segments become interior
 * nodes. Root name is the analyzed folder. Deterministic: dirs + leaves sorted.
 */
function buildTreemap(graph: Graph): TreemapNode {
  const byFile = functionsByFile(graph);
  const root = emptyDir(graph.root || ".");
  for (const module of graph.modules) {
    const segments = module.file.split("/").filter((s) => s.length > 0);
    const basename = segments.length > 0 ? segments[segments.length - 1] : module.file;
    let cursor = root;
    for (const segment of segments.slice(0, -1)) {
      let next = cursor.dirs.get(segment);
      if (!next) {
        next = emptyDir(segment);
        cursor.dirs.set(segment, next);
      }
      cursor = next;
    }
    cursor.leaves.push({
      name: basename,
      loc: module.loc,
      severity: fileSeverity(module, byFile),
      file: module.file,
      smellKinds: fileSmellKinds(module, byFile),
    });
  }
  return finalizeDir(root);
}

// --- Hub call graph (HTML-VIEW §3.2) ---

/** A function is a target if it has >=1 smell OR is a hub (calledBy.length >= 3). */
const HUB_FAN_IN = 3;

function fanInOf(fn: FunctionNode): number {
  return fn.edges ? fn.edges.calledBy.length : 0;
}

function isTarget(fn: FunctionNode): boolean {
  return fn.smells.length > 0 || fanInOf(fn) >= HUB_FAN_IN;
}

function toGraphNode(fn: FunctionNode, hidden: boolean): GraphNode {
  const node: GraphNode = {
    id: fn.id,
    label: fn.name,
    file: fn.file,
    startLine: fn.startLine,
    endLine: fn.endLine,
    loc: fn.loc,
    complexity: fn.complexity,
    fanIn: fanInOf(fn),
    callChainDepth: fn.edges ? fn.edges.callChainDepth : 0,
    severity: worstSeverity(fn.smells),
    smellKinds: [...new Set(fn.smells.map((s) => s.kind))].sort(),
  };
  if (hidden) node.hidden = true;
  return node;
}

/**
 * The included id-set: every target (true) plus its one-hop callers/callees
 * pulled in for context (false = neighbor, not itself a target). Only ids that
 * exist in byId enter -- external callees never resolve, so they drop out.
 */
function includedSet(
  targets: FunctionNode[],
  byId: Map<string, FunctionNode>,
): Map<string, boolean> {
  const included = new Map<string, boolean>();
  for (const fn of targets) included.set(fn.id, true);
  for (const fn of targets) {
    const neighborIds = [
      ...(fn.edges?.calls ?? []).map((c) => c.calleeId),
      ...(fn.edges?.calledBy ?? []).map((c) => c.callerId),
    ];
    for (const id of neighborIds) {
      if (byId.has(id) && !included.has(id)) included.set(id, false);
    }
  }
  return included;
}

/**
 * Caller->callee edges within the included set, deduped and sorted. A call whose
 * callee is not included (or is external) is dropped -- the graph only draws
 * edges between drawn nodes.
 */
function includedEdges(
  included: Map<string, boolean>,
  byId: Map<string, FunctionNode>,
): GraphEdge[] {
  const seen = new Set<string>();
  const edges: GraphEdge[] = [];
  for (const id of included.keys()) {
    for (const call of byId.get(id)?.edges?.calls ?? []) {
      const key = `${id} ${call.calleeId}`;
      if (!included.has(call.calleeId) || seen.has(key)) continue;
      seen.add(key);
      edges.push({ source: id, target: call.calleeId });
    }
  }
  edges.sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target));
  return edges;
}

/**
 * Project the function set into a cytoscape graph (HTML-VIEW §3.2): targets +
 * their one-hop neighbors as nodes, calls between included nodes as edges,
 * everything else counted in hiddenCount (no silent truncation). Deterministic.
 */
function buildGraph(graph: Graph): HtmlModel["graph"] {
  const byId = new Map<string, FunctionNode>();
  for (const fn of graph.functions) byId.set(fn.id, fn);

  const included = includedSet(graph.functions.filter(isTarget), byId);
  const nodes: GraphNode[] = [...included.entries()]
    .map(([id, isTargetNode]) => {
      const fn = byId.get(id);
      return fn ? toGraphNode(fn, !isTargetNode) : null;
    })
    .filter((n): n is GraphNode => n !== null)
    .sort((a, b) => a.id.localeCompare(b.id));

  return {
    nodes,
    edges: includedEdges(included, byId),
    hiddenCount: graph.functions.length - included.size,
  };
}

/**
 * Build the §4 HtmlModel from a Graph. PURE -- no DOM, no I/O, deterministic. The
 * plan is the default `rot` ranking (HTML-VIEW §3 top-targets); the human page
 * re-sorts it client-side by column.
 */
export function buildHtmlModel(graph: Graph): HtmlModel {
  return {
    summary: graph.summary,
    treemap: buildTreemap(graph),
    graph: buildGraph(graph),
    plan: rankPlan(graph.functions, "rot"),
  };
}
