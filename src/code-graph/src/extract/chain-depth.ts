import type { CallSite } from "../schema.js";

/**
 * chain-depth.ts — callChainDepth (SPEC §8-C5): the longest path through the
 * INTERNAL call graph, with cycles (recursion / mutual recursion) collapsed via
 * Tarjan SCC condensation so the computation is O(V+E) and recursion-safe.
 *
 * Pipeline: buildCallGraph → buildSccs (Tarjan) → condenseToDag → longestPathDepths.
 * Lifted out of edges.ts so the densest pass lives in its own focused module and
 * the longest-path machinery is the file's single concern.
 *
 * Depth semantics: a leaf (no internal callees) has depth 0. An SCC's depth is
 * `1 + max(depth of callee SCCs)` when it has outgoing edges to OTHER SCCs, plus
 * `1` extra when the SCC itself contains a cycle (size>1 or a self-loop) — the
 * cycle counts as one collapsed level of chaining. `external:*` callees are
 * excluded from the graph entirely. Every node in an SCC inherits the SCC depth.
 */

/** Is a callee id an external (unresolved) one? Externals are not graph nodes. */
function isExternal(id: string): boolean {
  return id.startsWith("external:");
}

/** The internal call graph: per-id callee adjacency + the set of self-recursive ids. */
type CallGraph = {
  /** id → distinct internal (non-external, non-self) callee ids. */
  adj: Map<string, string[]>;
  /** ids that call themselves directly (handled via the SCC-cycle bonus). */
  selfLoop: Set<string>;
};

/** The condensed DAG over SCCs: callee-SCC edges + which SCCs are cyclic. */
type CondensedDag = {
  /** SCC → set of callee SCC indices (no self-edges). */
  sccEdges: Map<number, Set<number>>;
  /** SCC → true when it collapses a cycle (size>1 or a self-loop member). */
  sccIsCyclic: Map<number, boolean>;
};

/**
 * Build the internal call-graph adjacency. External callees and ids outside the
 * enumerated set are dropped; a self-call is recorded in `selfLoop` (not
 * adjacency) so a recursive id is detected via the cycle bonus.
 */
function buildCallGraph(ids: string[], callsById: Map<string, CallSite[]>): CallGraph {
  const idSet = new Set(ids);
  const adj = new Map<string, string[]>();
  const selfLoop = new Set<string>();
  for (const id of ids) {
    const outs: string[] = [];
    for (const c of callsById.get(id) ?? []) {
      if (isExternal(c.calleeId) || !idSet.has(c.calleeId)) continue;
      if (c.calleeId === id) {
        selfLoop.add(id); // self-edge handled via the SCC-cycle bonus, not adjacency
      } else {
        outs.push(c.calleeId);
      }
    }
    adj.set(id, [...new Set(outs)]);
  }
  return { adj, selfLoop };
}

/** A frame of the iterative DFS: the node plus its child cursor. */
type Frame = { node: string; i: number };

/** Mutable bookkeeping for one Tarjan run; the loop helpers mutate it in place. */
type TarjanState = {
  index: Map<string, number>;
  low: Map<string, number>;
  onStack: Set<string>;
  stack: string[];
  sccOf: Map<string, number>;
  work: Frame[];
  counter: number;
  sccCount: number;
};

/** Mark a not-yet-seen node: assign its index/low, push it onto both stacks. */
function discover(st: TarjanState, node: string): void {
  st.index.set(node, st.counter);
  st.low.set(node, st.counter);
  st.counter += 1;
  st.stack.push(node);
  st.onStack.add(node);
}

/**
 * Advance the top frame to its next neighbor. Returns true while the frame still
 * has children to process (descend into a fresh one or fold a back-edge's index
 * into the low-link); false when the frame is exhausted and ready to close.
 */
function advanceFrame(st: TarjanState, frame: Frame, neighbors: string[]): boolean {
  if (frame.i >= neighbors.length) return false;
  const next = neighbors[frame.i];
  frame.i += 1;
  if (!st.index.has(next)) {
    discover(st, next);
    st.work.push({ node: next, i: 0 });
  } else if (st.onStack.has(next)) {
    st.low.set(frame.node, Math.min(st.low.get(frame.node) ?? 0, st.index.get(next) ?? 0));
  }
  return true;
}

/**
 * Close the exhausted top frame: if it is an SCC root (low === index), pop the
 * stack down to it and assign every popped member the next SCC index; then pop
 * the frame and roll its low-link into its parent.
 */
function closeFrame(st: TarjanState, frame: Frame): void {
  if ((st.low.get(frame.node) ?? 0) === (st.index.get(frame.node) ?? 0)) {
    for (;;) {
      const w = st.stack.pop();
      if (w === undefined) break;
      st.onStack.delete(w);
      st.sccOf.set(w, st.sccCount);
      if (w === frame.node) break;
    }
    st.sccCount += 1;
  }
  st.work.pop();
  const parent = st.work[st.work.length - 1];
  if (parent) {
    st.low.set(parent.node, Math.min(st.low.get(parent.node) ?? 0, st.low.get(frame.node) ?? 0));
  }
}

/**
 * Tarjan's SCC, iterative (recursion-safe for large graphs). Cycles collapse
 * into one SCC so the condensation is acyclic. Returns id → SCC index.
 */
function buildSccs(ids: string[], adj: Map<string, string[]>): Map<string, number> {
  const st: TarjanState = {
    index: new Map(),
    low: new Map(),
    onStack: new Set(),
    stack: [],
    sccOf: new Map(),
    work: [],
    counter: 0,
    sccCount: 0,
  };

  for (const start of ids) {
    if (st.index.has(start)) continue;
    discover(st, start);
    st.work = [{ node: start, i: 0 }];
    while (st.work.length > 0) {
      const frame = st.work[st.work.length - 1];
      const neighbors = adj.get(frame.node) ?? [];
      if (!advanceFrame(st, frame, neighbors)) closeFrame(st, frame);
    }
  }
  return st.sccOf;
}

/** Group ids by their SCC index (members of each SCC). */
function groupSccMembers(ids: string[], sccOf: Map<string, number>): Map<number, string[]> {
  const sccMembers = new Map<number, string[]>();
  for (const id of ids) {
    const s = sccOf.get(id);
    if (s === undefined) continue;
    const arr = sccMembers.get(s) ?? [];
    arr.push(id);
    sccMembers.set(s, arr);
  }
  return sccMembers;
}

/**
 * Condense the call graph to a DAG over SCCs: edges between DISTINCT SCCs, plus
 * a per-SCC cyclic flag (member count > 1, or a self-loop member). Acyclic, so
 * longest-path is well-defined.
 */
function condenseToDag(ids: string[], graph: CallGraph, sccOf: Map<string, number>): CondensedDag {
  const sccMembers = groupSccMembers(ids, sccOf);
  const sccEdges = new Map<number, Set<number>>();
  const sccIsCyclic = new Map<number, boolean>();
  for (const [s, members] of sccMembers) {
    sccEdges.set(s, new Set());
    sccIsCyclic.set(s, members.length > 1 || members.some((m) => graph.selfLoop.has(m)));
  }
  for (const id of ids) {
    const from = sccOf.get(id);
    if (from === undefined) continue;
    for (const callee of graph.adj.get(id) ?? []) {
      const to = sccOf.get(callee);
      if (to === undefined || to === from) continue;
      sccEdges.get(from)?.add(to);
    }
  }
  return { sccEdges, sccIsCyclic };
}

/**
 * Longest path over the condensed DAG, memoized post-order (DAG → no cycles).
 * Returns id → chain depth: a leaf is 0; an SCC's depth is `1 + max(callee-SCC
 * depth)` for its outgoing chaining, plus `1` when the SCC itself is a cycle.
 * Every member id inherits its SCC's depth.
 */
function longestPathDepths(
  ids: string[],
  sccOf: Map<string, number>,
  dag: CondensedDag,
): Map<string, number> {
  const sccDepth = new Map<number, number>();
  function depthOf(s: number): number {
    const cached = sccDepth.get(s);
    if (cached !== undefined) return cached;
    sccDepth.set(s, 0); // guard (DAG, so never revisited mid-flight)
    let maxChild = -1;
    for (const to of dag.sccEdges.get(s) ?? []) {
      maxChild = Math.max(maxChild, depthOf(to));
    }
    // 1 per outgoing chaining level; +1 more if this SCC is itself a cycle.
    const base = maxChild < 0 ? 0 : maxChild + 1;
    const d = base + (dag.sccIsCyclic.get(s) ? 1 : 0);
    sccDepth.set(s, d);
    return d;
  }

  const out = new Map<string, number>();
  for (const id of ids) {
    const s = sccOf.get(id);
    out.set(id, s === undefined ? 0 : depthOf(s));
  }
  return out;
}

/**
 * callChainDepth (SPEC §8-C5): build the internal call graph, collapse cycles
 * with Tarjan SCC, condense to a DAG, and take the longest path. O(V+E) and
 * recursion-safe (cycles are pre-collapsed). `external:*` callees are excluded.
 */
export function computeChainDepths(
  ids: string[],
  callsById: Map<string, CallSite[]>,
): Map<string, number> {
  const graph = buildCallGraph(ids, callsById);
  const sccOf = buildSccs(ids, graph.adj);
  const dag = condenseToDag(ids, graph, sccOf);
  return longestPathDepths(ids, sccOf, dag);
}
