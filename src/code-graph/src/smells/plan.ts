import { distinctExternalCallers } from "../extract/edges.js";
import type { FunctionNode, PlanRow } from "../schema.js";

/**
 * plan.ts — deterministic refactor-target ranking (SPEC §7).
 *
 * Every function becomes a PlanRow carrying its coordinates plus `components`
 * (smells/complexity/fanIn) so the agent can re-rank itself without a second
 * call. The four axes:
 *  - rot        (default) "where's the rot": (smells, complexity, calledBy) desc
 *  - impact     "what's risky to change": calledBy first (needs the edge pass)
 *  - complexity complexity first
 *  - size       loc first
 *
 * Every axis tiebreaks on `(file, startLine)` so order is total + stable (§3/§6).
 * fanIn is only meaningful when the edge pass ran; in the cheap pass it is `null`
 * (unknown) and the CLI refuses `--by impact` rather than rank on a missing value.
 */

export type PlanAxis = "rot" | "impact" | "complexity" | "size";

export const PLAN_AXES: readonly PlanAxis[] = ["rot", "impact", "complexity", "size"];

export function isPlanAxis(value: string): value is PlanAxis {
  return (PLAN_AXES as readonly string[]).includes(value);
}

/**
 * The ranking score is the same magnitude for every axis — a single number the
 * agent can read at a glance — built from the same three components, weighted so
 * the axis's lead component dominates. Ordering is decided by the comparator
 * below (which sorts by the raw component tuple), not by this scalar; the score
 * is descriptive, the comparator is authoritative.
 *
 * When the edge pass did not run, `fanIn` is `null` (UNKNOWN). It coalesces to 0
 * here, so the `rot`/`complexity` scores DROP the fanIn term in cheap mode rather
 * than treating every function as a measured-zero hub. `impact` is never scored
 * in cheap mode — the CLI refuses it before we get here.
 */
function scoreFor(row: Omit<PlanRow, "score">, axis: PlanAxis): number {
  const { smells: smellCount, complexity, fanIn } = row.components;
  const fan = fanIn ?? 0;
  switch (axis) {
    case "rot":
      return smellCount * 1000 + complexity * 10 + fan;
    case "impact":
      return fan * 1000 + complexity * 10 + smellCount;
    case "complexity":
      return complexity * 1000 + smellCount * 10 + fan;
    case "size":
      return row.loc;
  }
}

/**
 * Build the unranked PlanRow for one function (coordinates + components).
 * `fn.edges === null` → the edge pass did not run, so fanIn/calledByCount are
 * `null` (unknown), not 0. `edgesComputed` (the run-level flag) and `fn.edges`
 * always agree; we read fanIn straight off the block so the two can't drift.
 *
 * fanIn = `distinctExternalCallers`, not `calledBy.length`: `calledBy` is one
 * entry per call SITE, so a self-recursive function would otherwise rank on its
 * own recursion under `--by impact` (SPEC §5, §8-C2). Excluding self keeps the
 * impact axis = "how many other functions depend on this."
 */
function toRow(fn: FunctionNode): Omit<PlanRow, "score"> {
  const fanIn = fn.edges ? distinctExternalCallers(fn.id, fn.edges.calledBy) : null;
  return {
    id: fn.id,
    file: fn.file,
    startLine: fn.startLine,
    endLine: fn.endLine,
    components: {
      smells: fn.smells.length,
      complexity: fn.complexity,
      fanIn,
    },
    loc: fn.loc,
    complexity: fn.complexity,
    calledByCount: fanIn,
    smells: fn.smells,
  };
}

/**
 * The descending sort keys for each axis, in priority order. Each axis is the
 * same three components reordered (size is loc alone). Expressing the ordering as
 * DATA — a key list per axis — keeps the comparator a single loop instead of a
 * branch per axis. Unknown fanIn (cheap pass) coalesces to 0, inert as a key when
 * every row is null, so cheap-mode ordering never leans on an unmeasured value.
 */
const AXIS_KEYS: Record<PlanAxis, ((row: PlanRow) => number)[]> = {
  rot: [(r) => r.components.smells, (r) => r.components.complexity, (r) => r.components.fanIn ?? 0],
  impact: [
    (r) => r.components.fanIn ?? 0,
    (r) => r.components.complexity,
    (r) => r.components.smells,
  ],
  complexity: [
    (r) => r.components.complexity,
    (r) => r.components.smells,
    (r) => r.components.fanIn ?? 0,
  ],
  size: [(r) => r.loc],
};

/** The axis's PRIMARY ordering: each keyed component compared descending, in order. */
function comparePrimary(a: PlanRow, b: PlanRow, axis: PlanAxis): number {
  for (const key of AXIS_KEYS[axis]) {
    const diff = key(b) - key(a);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** The per-axis ordering: leading keys descending, then `(file, startLine, id)`. */
function compare(a: PlanRow, b: PlanRow, axis: PlanAxis): number {
  // Final tiebreak on `id` (carries the `#ordinal`, so unique) makes the order
  // TOTAL by construction — two rows with the same (file, startLine) no longer
  // rely on V8's stable sort to keep a defined order (SPEC §3).
  return (
    comparePrimary(a, b, axis) ||
    a.file.localeCompare(b.file) ||
    a.startLine - b.startLine ||
    a.id.localeCompare(b.id)
  );
}

/**
 * Rank every function into PlanRows under the chosen axis. Whether fanIn is a
 * measured number or `null` (unknown) is decided per-function by `fn.edges`
 * (null = cheap pass) — see toRow/scoreFor. The run-level `edgesComputed` flag
 * (= `provenance.pass === "edges"`) is no longer needed: it always agrees with
 * `fn.edges !== null`, so the node IS the source of truth.
 */
export function rankPlan(functions: FunctionNode[], axis: PlanAxis): PlanRow[] {
  const rows: PlanRow[] = functions.map((fn) => {
    const base = toRow(fn);
    return { ...base, score: scoreFor(base, axis) };
  });
  rows.sort((a, b) => compare(a, b, axis));
  return rows;
}
