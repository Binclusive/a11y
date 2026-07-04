import type { Graph } from "../schema.js";

/**
 * ci.ts — the `--ci` gate (SPEC §10): turn the graph's smells into a pass/fail
 * decision plus a one-line report. Pure: it computes the verdict; the CLI owns
 * `process.exitCode` and stdout.
 *
 * Policy (§10), fail if EITHER condition trips:
 *  - `--fail-on high` (default): fail when any `high`-severity smell exists.
 *  - `--fail-on warn`: fail when any smell exists at all.
 *  - `--max <n>`: fail when the total smell count exceeds `n`.
 *
 * The cheap pass already produces every smell except `high-fan-in` /
 * `deep-call-chain`; pass `--edges`/`--deep` to let those gate too (the CLI runs
 * the edge pass first, so the graph handed here already carries them).
 */

export type FailOn = "high" | "warn";

export type CiResult = {
  /** True when the gate passed (exit 0); false means a policy tripped (exit 1). */
  passed: boolean;
  /** One-line human report for stdout. */
  report: string;
};

/** `"high"` or `"warn"`; anything else falls back to the default `"high"`. */
export function isFailOn(value: string): value is FailOn {
  return value === "high" || value === "warn";
}

/**
 * The human reason fragment for each policy that tripped (SPEC §10): the
 * `fail-on` severity gate and the `--max` count gate. Empty when nothing tripped.
 */
function failureReasons(total: number, high: number, failOn: FailOn, max: number | null): string[] {
  const reasons: string[] = [];
  if (failOn === "high" && high > 0) {
    reasons.push(`${high} high-severity smell${high === 1 ? "" : "s"}`);
  }
  if (failOn === "warn" && total > 0) {
    reasons.push(`${total} smell${total === 1 ? "" : "s"} (fail-on=warn)`);
  }
  if (max !== null && total > max) {
    const phrase = total === 1 ? "smell exceeds" : "smells exceed";
    reasons.push(`${total} ${phrase} --max ${max}`);
  }
  return reasons;
}

export function evaluateCi(graph: Graph, failOn: FailOn, max: number | null): CiResult {
  const total = graph.smells.length;
  const high = graph.smells.filter((s) => s.severity === "high").length;

  const reasons = failureReasons(total, high, failOn, max);
  if (reasons.length > 0) {
    return { passed: false, report: `code-graph CI: FAIL — ${reasons.join("; ")}.` };
  }

  const maxNote = max !== null ? `, max ${max}` : "";
  return {
    passed: true,
    report: `code-graph CI: PASS — ${total} smells, ${high} high-severity (fail-on=${failOn}${maxNote}).`,
  };
}
