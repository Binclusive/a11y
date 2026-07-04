import { selfRecursiveCallCount } from "../extract/edges.js";
import type { FunctionNode, Graph } from "../schema.js";
import { stableStringify } from "./json.js";

/**
 * blast.ts — the `--blast <id>` render (SPEC §10): direct + transitive callers
 * of a target function, each as `{ callerId, file, line, depth }`, plus the
 * target's own downstream chain length as `targetCallChainDepth`.
 *
 * Target resolution: `<id>` may be the full `file:name` id or a BARE name. A
 * bare name that matches >1 function is AMBIGUOUS — we return the candidate ids
 * and signal a non-zero exit (the caller must pass an unambiguous id, SPEC §2).
 *
 * Scope (SPEC §10): the output carries the run's scope. In `package` scope the
 * callers are complete only within the package, so `crossPackageCallersOmitted`
 * is `true` and a warning tells the agent to re-run with `--deep`.
 *
 * Self-recursion (SPEC §5, §8): the target's own self-calls are NOT callers —
 * they don't widen the blast radius. They are dropped from `callers` (so the
 * count agrees with fanIn = `distinctExternalCallers`) and surfaced separately as
 * `recursiveSelfCalls` so "it's recursive" stays visible without inflating fan-in.
 *
 * Determinism (SPEC §3): callers are sorted by (depth, callerId, line).
 */

export type BlastCaller = {
  callerId: string;
  file: string;
  line: number;
  /** Hops up the calledBy graph from the target (direct caller = 1). */
  depth: number;
};

export type BlastResult = {
  /** stdout payload (JSON), or null when nothing to print on stdout. */
  stdout: string | null;
  /** stderr warning, or null. */
  warning: string | null;
  /** Process exit code: non-zero on ambiguity or missing target (SPEC §10). */
  exitCode: number;
};

type BlastOutput = {
  target: string;
  scope: "package" | "deep";
  /**
   * The TARGET's own downstream call-chain depth (how deep its callees go) —
   * NOT a caller-side number. Named with the `target` prefix so a reader of a
   * callers report can't misread it as the depth of the caller tree below.
   */
  targetCallChainDepth: number;
  crossPackageCallersOmitted: boolean;
  /**
   * Count of the target's own self-recursive call SITES. NOT a caller (recursion
   * doesn't widen the blast radius) — surfaced separately so the recursion signal
   * stays visible. `callers.length` = distinct external callers = the target's
   * fanIn; the two always agree (SPEC §5, §8).
   */
  recursiveSelfCalls: number;
  callers: BlastCaller[];
};

/** Find the function(s) a `<id>` refers to: exact id first, else bare-name. */
function resolveTargets(functions: FunctionNode[], idOrName: string): FunctionNode[] {
  const exact = functions.filter((f) => f.id === idOrName);
  if (exact.length > 0) return exact;
  return functions.filter((f) => f.name === idOrName);
}

/** BFS bookkeeping: each caller's best (shortest) depth + the line at that depth. */
type CallerTraversal = {
  bestDepth: Map<string, number>;
  bestLine: Map<string, number>;
  visited: Set<string>;
  queue: { id: string; depth: number }[];
};

/**
 * Relax one calledBy edge: if this path reaches the caller at a shorter depth,
 * record the new best depth + call-site line; enqueue the caller the first time
 * it is seen (BFS already discovers it at its minimum depth).
 *
 * `targetId` self-edges are skipped: the target's own recursion is not a caller
 * (doesn't widen the blast radius) and is surfaced separately as
 * `recursiveSelfCalls`, so `callers.length` equals the target's fanIn (SPEC §5, §8).
 */
function relaxCaller(
  tr: CallerTraversal,
  targetId: string,
  callerId: string,
  line: number,
  depth: number,
): void {
  if (callerId === targetId) return;
  const cDepth = depth + 1;
  const prev = tr.bestDepth.get(callerId);
  if (prev === undefined || cDepth < prev) {
    tr.bestDepth.set(callerId, cDepth);
    tr.bestLine.set(callerId, line);
  }
  if (!tr.visited.has(callerId)) {
    tr.visited.add(callerId);
    tr.queue.push({ id: callerId, depth: cDepth });
  }
}

/**
 * Walk UP the calledBy graph from the target, BFS, assigning each reachable
 * caller its shortest hop distance (depth) from the target. A function reached
 * by multiple paths keeps its minimum depth. The `line` recorded is the call
 * site on the EDGE that first discovered the caller at that depth (the line in
 * the caller where it calls into the next node toward the target).
 */
function collectCallers(byId: Map<string, FunctionNode>, target: FunctionNode): BlastCaller[] {
  // Start from the target at depth 0; its direct callers are depth 1.
  const tr: CallerTraversal = {
    bestDepth: new Map(),
    bestLine: new Map(),
    visited: new Set([target.id]),
    queue: [{ id: target.id, depth: 0 }],
  };

  // Index cursor, not queue.shift(): shift() reindexes the whole array per
  // dequeue → O(n²), noticeable in `--deep`. Same BFS order (FIFO), O(V+E).
  let i = 0;
  while (i < tr.queue.length) {
    const head = tr.queue[i++];
    if (!head) break;
    const node = byId.get(head.id);
    if (!node?.edges) continue;
    for (const caller of node.edges.calledBy) {
      relaxCaller(tr, target.id, caller.callerId, caller.line, head.depth);
    }
  }

  const callers: BlastCaller[] = [];
  for (const [cId, depth] of tr.bestDepth) {
    const node = byId.get(cId);
    callers.push({
      callerId: cId,
      file: node ? node.file : "",
      line: tr.bestLine.get(cId) ?? 0,
      depth,
    });
  }
  callers.sort(
    (a, b) => a.depth - b.depth || a.callerId.localeCompare(b.callerId) || a.line - b.line,
  );
  return callers;
}

/**
 * Resolve `<id>` to a single target function, or return the BlastResult error to
 * emit (SPEC §10): no match → exit 1 with a parseFailures hint when relevant; an
 * ambiguous bare name → exit 1 listing the candidate ids.
 */
function resolveSingleTarget(
  graph: Graph,
  idOrName: string,
): { target: FunctionNode } | { error: BlastResult } {
  const targets = resolveTargets(graph.functions, idOrName);
  if (targets.length === 0) {
    const inFailure = graph.summary.parseFailures.some((f) => idOrName.startsWith(f));
    const hint = inFailure ? " (its file is in parseFailures and was excluded)" : "";
    return {
      error: {
        stdout: null,
        warning: `error: no function matches "${idOrName}"${hint}. Pass an id (file:name) from --graph/--plan.`,
        exitCode: 1,
      },
    };
  }
  if (targets.length > 1) {
    const candidates = targets.map((t) => t.id).sort((a, b) => a.localeCompare(b));
    const list = candidates.map((c) => `  ${c}`).join("\n");
    return {
      error: {
        stdout: null,
        warning: `error: "${idOrName}" is ambiguous — ${candidates.length} matches. Pass one id:\n${list}`,
        exitCode: 1,
      },
    };
  }
  return { target: targets[0] };
}

/** Human render: a compact callers table the agent can read at a glance. */
function renderBlastHuman(output: BlastOutput): string {
  const lines: string[] = [];
  lines.push(`blast: ${output.target}`);
  lines.push(`scope: ${output.scope}  targetCallChainDepth: ${output.targetCallChainDepth}`);
  if (output.recursiveSelfCalls > 0) {
    lines.push(`recursive: ${output.recursiveSelfCalls} self-calls (not counted as fan-in)`);
  }
  if (output.callers.length === 0) {
    lines.push("callers: (none in scope)");
  } else {
    lines.push(`callers (${output.callers.length}):`);
    for (const c of output.callers) {
      lines.push(`  d${c.depth}  ${c.callerId}  ${c.file}:${c.line}`);
    }
  }
  return lines.join("\n");
}

export function renderBlast(
  graph: Graph,
  idOrName: string,
  json: boolean,
  pretty: boolean,
): BlastResult {
  // Edge data is required (SPEC §10). The CLI only reaches here after the edge
  // pass, but guard so a cheap-pass graph fails loud, not silently empty.
  if (graph.provenance.pass !== "edges") {
    return {
      stdout: null,
      warning: "warning: --blast requires the edge pass; this graph has none.",
      exitCode: 2,
    };
  }
  const scope = graph.provenance.scope;

  const resolved = resolveSingleTarget(graph, idOrName);
  if ("error" in resolved) return resolved.error;
  const { target } = resolved;

  const byId = new Map(graph.functions.map((f) => [f.id, f]));
  const callers = collectCallers(byId, target);
  // The `pass !== "edges"` guard above means every function's `edges` block is
  // populated; `?? 0`/`?? []` only satisfy the type, they never fire here.
  // `callers.length` (distinct external callers) equals the target's fanIn, and
  // self-recursion is reported separately — the blast count and fanIn agree.
  const selfCalls = selfRecursiveCallCount(target.id, target.edges?.calledBy ?? []);
  const output: BlastOutput = {
    target: target.id,
    scope,
    targetCallChainDepth: target.edges?.callChainDepth ?? 0,
    crossPackageCallersOmitted: scope === "package",
    recursiveSelfCalls: selfCalls,
    callers,
  };

  const warning =
    scope === "package"
      ? "warning: package scope — cross-package callers omitted. Re-run with --deep for the full blast radius."
      : null;

  const stdout = json ? stableStringify(output, pretty) : renderBlastHuman(output);
  return { stdout, warning, exitCode: 0 };
}
