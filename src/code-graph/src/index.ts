#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { assembleGraph, assembleGraphWithEdges } from "./extract/assemble.js";
import {
  type EdgeScope,
  type LoadedEdgeProject,
  loadCheapProject,
  loadEdgeProject,
} from "./extract/project.js";
import { renderBlast } from "./render/blast.js";
import { evaluateCi, type FailOn, isFailOn } from "./render/ci.js";
import { renderFile } from "./render/file.js";
import { renderGraph } from "./render/graph.js";
import { renderHtml } from "./render/html.js";
import { renderPlan } from "./render/plan.js";
import { renderSmells } from "./render/smells.js";
import { renderSummary } from "./render/summary.js";
import { renderTree } from "./render/tree.js";
import type { Graph } from "./schema.js";
import { type Thresholds, ThresholdsSchema } from "./schema.js";
import { isPlanAxis, type PlanAxis } from "./smells/plan.js";

/**
 * CLI (SPEC §10). Default loads the CHEAP pass (no tsconfig — fast, cheap-pass
 * smells incl. directory-sprawl). The opt-in EDGE pass runs when any of
 * `--edges` / `--deep` / `--blast <id>` is passed (SPEC §3): it loads a
 * type-aware project (nearest tsconfig for `package`, root tsconfig for
 * `deep`), resolves calls/calledBy/importedBy/callChainDepth, and fires the
 * edge smells (high-fan-in, deep-call-chain). `--blast` queries callers of one
 * function; the rest render the assembled Graph per flag.
 *
 * `--ci` is a gate, not a view: it exits non-zero per `--fail-on`/`--max` (§10).
 * It runs the cheap pass by default; pass `--edges`/`--deep` to let the edge
 * smells gate too. `--tree` is the indented file → function view (text only).
 */

type Opts = {
  pretty?: boolean;
  json?: boolean;
  graph?: boolean;
  plan?: boolean;
  smells?: boolean;
  tree?: boolean;
  by?: string;
  file?: string;
  edges?: boolean;
  deep?: boolean;
  blast?: string;
  html?: boolean;
  ci?: boolean;
  failOn?: string;
  max?: string;
  thresholds?: string;
};

/**
 * The single clean-exit path (SPEC §10/§11): write a one-line message to stderr,
 * set exit code 2, and return — never throw a raw stack trace at the agent. Both
 * the `--thresholds` parse boundary and the edge-pass no-tsconfig case route
 * through here, so there is ONE error path, not two.
 */
function cleanExit(message: string): void {
  process.stderr.write(`code-graph: ${message}\n`);
  process.exitCode = 2;
}

/**
 * Resolve the active thresholds (SPEC §5/§10, Parse-Don't-Validate). With no
 * `--thresholds`, the defaults are `ThresholdsSchema.parse({})`. With a file:
 * read → JSON.parse → `ThresholdsSchema.partial().parse(...)` (a typo'd key or
 * wrong-typed value is a parse error, not silent corruption) → merge the parsed
 * partial OVER the defaults. Any failure (missing/unreadable file, bad JSON,
 * schema rejection) returns `null` after a clean stderr line — the caller exits.
 */
function resolveThresholds(file: string | undefined): Thresholds | null {
  const defaults = ThresholdsSchema.parse({});
  if (file === undefined) return defaults;

  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    cleanExit(`cannot read thresholds file "${file}".`);
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    cleanExit(`thresholds file "${file}" is not valid JSON.`);
    return null;
  }

  const result = ThresholdsSchema.partial().safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue?.path.join(".") || "(root)";
    cleanExit(`invalid thresholds in "${file}": ${where}: ${issue?.message ?? "parse error"}.`);
    return null;
  }
  return { ...defaults, ...result.data };
}

/**
 * Find the monorepo root for `--deep`: walk up from `start` to the topmost
 * directory containing a `pnpm-workspace.yaml` (the workspace root). When no
 * workspace marker is found anywhere up the tree, fall back to `start` itself.
 */
function findRepoRoot(start: string): string {
  let dir = start;
  let workspaceRoot: string | null = null;
  for (;;) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) workspaceRoot = dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return workspaceRoot ?? start;
}

const program = new Command();

program
  .name("code-graph")
  .description("Agent-native TypeScript code-graph tool (SPEC.md)")
  .argument("<path>", "folder to analyze")
  .option("--graph", "emit the full Graph JSON (the large dump)")
  .option("--plan", "emit ranked refactor targets (human table; --json for PlanRow[])")
  .option("--by <axis>", "plan ranking axis: rot | impact | complexity | size", "rot")
  .option("--smells", "emit all smells grouped by kind (human; --json for Smell[])")
  .option("--tree", "emit an indented file → function tree with inline smell markers")
  .option("--file <f>", "emit one module + its functions")
  .option("--edges", "run the opt-in edge pass (calls/calledBy/importedBy/chain + edge smells)")
  .option("--deep", "edge pass over the whole monorepo (cross-package callers; implies --edges)")
  .option("--blast <id>", "callers of <id> (direct + transitive); requires the edge pass")
  .option("--html", "emit a self-contained HTML report (human view); implies the edge pass")
  .option("--ci", "CI gate: exit non-zero per --fail-on / --max policy")
  .option("--fail-on <level>", "CI severity to fail on: high | warn", "high")
  .option("--max <n>", "CI: fail if total smell count exceeds <n>")
  .option("--thresholds <file>", "JSON file of partial threshold overrides merged over defaults")
  .option("--pretty", "pretty-print JSON output")
  .option("--json", "force JSON output on a view command")
  .action((targetPath: string, opts: Opts) => {
    const resolved = path.resolve(targetPath);

    // Filesystem guard (SPEC §11: never crash, never lie). Without this, an
    // unguarded root sends ts-morph's `**/*.ts` glob across the whole tree —
    // `code-graph /` walks the entire filesystem and hangs forever (the worst
    // failure for an agent) — while a nonexistent or file path glob-matches
    // nothing and returns exit 0 / health "healthy" / fileCount 0, which an
    // agent can't tell apart from a genuinely clean run. One guard, routed
    // through the SAME clean-exit helper, closes both: exit 2, one line, no
    // hang. An empty-but-real directory still succeeds (§11).
    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved); // follows symlinks → a symlinked dir passes
    } catch {
      cleanExit(`no such path: ${resolved}`);
      return;
    }
    if (!stat.isDirectory()) {
      cleanExit(`${resolved} is not a directory`);
      return;
    }
    // Resolve through the symlink so ts-morph globs the REAL directory — its
    // glob does not traverse a symlink, so a symlinked dir would otherwise
    // report fileCount 0. Use the real path consistently as the analyzed root.
    const rootAbsolute = fs.realpathSync(resolved);

    // Parse boundary (SPEC §5/§10): merge --thresholds overrides over defaults.
    // On any failure resolveThresholds has already written the one-line stderr
    // message + set exit code 2 — return cleanly, no stack trace.
    const thresholds = resolveThresholds(opts.thresholds);
    if (thresholds === null) return;

    const pretty = opts.pretty === true;
    const json = opts.json === true;

    // The edge pass is opt-in (SPEC §3): --edges, --deep, or --blast trigger it.
    // --html also implies it — the call-graph section needs calls (HTML-VIEW §5).
    const wantEdges =
      opts.edges === true ||
      opts.deep === true ||
      typeof opts.blast === "string" ||
      opts.html === true;
    const scope: EdgeScope = opts.deep === true ? "deep" : "package";

    // --by only takes effect inside the --plan branch. Commander gives the
    // default "rot" when --by is absent, so a non-"rot" value with no --plan is
    // an explicit axis the run would silently drop. Warn rather than ignore it
    // (the impact-needs-edges refusal still lives inside the --plan branch).
    if (opts.plan !== true && opts.by !== undefined && opts.by !== "rot") {
      process.stderr.write(`warning: --by ${opts.by} has no effect without --plan.\n`);
    }

    let graph: Graph;
    if (wantEdges) {
      // The edge pass needs a tsconfig to resolve modules (SPEC §3). loadEdgeProject
      // resolves it internally and throws when none is reachable — catch THAT and
      // clean-exit via the SAME helper as --thresholds (one error path, one FS
      // walk, never a raw stack). assembleGraphWithEdges runs outside the try so a
      // genuine assembly error is not misreported as a missing tsconfig.
      const repoRoot = findRepoRoot(rootAbsolute);
      let loaded: LoadedEdgeProject;
      try {
        loaded = loadEdgeProject(rootAbsolute, scope, repoRoot);
      } catch {
        cleanExit(`no tsconfig found for edge pass at ${rootAbsolute}; edges unavailable`);
        return;
      }
      graph = assembleGraphWithEdges(loaded, thresholds, scope, loaded.tsConfigPath);
    } else {
      graph = assembleGraph(loadCheapProject(rootAbsolute), thresholds);
    }

    if (opts.ci === true) {
      const requested = opts.failOn ?? "high";
      let failOn: FailOn = "high";
      if (isFailOn(requested)) {
        failOn = requested;
      } else {
        process.stderr.write(
          `warning: unknown --fail-on "${requested}"; falling back to "high".\n`,
        );
      }
      // Parse --max strictly: only a clean run of digits is a non-negative
      // integer. `Number.parseInt` would silently floor "2.9" → 2 and lose
      // precision on huge/"1e9" inputs — reject those instead of coercing.
      let max: number | null = null;
      if (opts.max !== undefined) {
        const trimmed = opts.max.trim();
        if (!/^\d+$/.test(trimmed)) {
          process.stderr.write(`error: --max expects a non-negative integer, got "${opts.max}".\n`);
          process.exitCode = 2;
          return;
        }
        max = Number.parseInt(trimmed, 10);
      }
      const { passed, report } = evaluateCi(graph, failOn, max);
      process.stdout.write(`${report}\n`);
      if (!passed) process.exitCode = 1;
      return;
    }

    // --html is the human-facing report (HTML-VIEW.md). Purely additive — it
    // never touches the JSON/summary/plan/blast paths; it writes a self-contained
    // page to stdout (no --out — redirect to a file). The edge pass already ran
    // (wantEdges includes --html), so the call-graph section is populated.
    if (opts.html === true) {
      process.stdout.write(renderHtml(graph));
      return;
    }

    if (typeof opts.blast === "string") {
      const { stdout, warning, exitCode } = renderBlast(graph, opts.blast, json, pretty);
      if (warning) process.stderr.write(`${warning}\n`);
      if (stdout !== null) process.stdout.write(`${stdout}\n`);
      if (exitCode !== 0) process.exitCode = exitCode;
      return;
    }

    if (typeof opts.file === "string") {
      const { stdout, warning } = renderFile(graph, rootAbsolute, opts.file, pretty);
      if (warning) process.stderr.write(`${warning}\n`);
      if (stdout !== null) process.stdout.write(`${stdout}\n`);
      return;
    }

    if (opts.plan === true) {
      const requested = opts.by ?? "rot";
      let axis: PlanAxis = "rot";
      if (isPlanAxis(requested)) {
        axis = requested;
      } else {
        process.stderr.write(`warning: unknown --by axis "${requested}"; falling back to "rot".\n`);
      }
      // --by impact ranks on fanIn, which is UNKNOWN in the cheap pass. Refuse
      // rather than return a degenerate (all-fanIn-null) ranking that looks
      // authoritative but isn't (SPEC §10). The agent must opt into the edge pass.
      if (axis === "impact" && graph.provenance.pass !== "edges") {
        cleanExit("--by impact needs the call graph; add --edges");
        return;
      }
      process.stdout.write(`${renderPlan(graph, axis, json, pretty)}\n`);
      return;
    }

    if (opts.smells === true) {
      process.stdout.write(`${renderSmells(graph, json, pretty)}\n`);
      return;
    }

    if (opts.tree === true) {
      // --json is not meaningful for a tree (SPEC §10): fall back to the
      // structured graph so a JSON consumer still gets machine-readable output.
      if (json) {
        process.stdout.write(`${renderGraph(graph, pretty)}\n`);
        return;
      }
      process.stdout.write(`${renderTree(graph)}\n`);
      return;
    }

    if (opts.graph === true) {
      process.stdout.write(`${renderGraph(graph, pretty)}\n`);
      return;
    }

    process.stdout.write(`${renderSummary(graph, pretty)}\n`);
  });

program.parse();
