/**
 * The `check` command's OPT-IN blocking gate (issue #2134).
 *
 * By default `check` exits non-zero only when a contract-BLOCKING finding fired
 * (`enforcement === "block"`); a scan that surfaces only warn-level findings is a
 * clean build. This module adds a strictly opt-in overlay: `--fail-on <severity>`
 * fails the check when any finding is at or above a severity threshold, and
 * `--max-violations <n>` fails it when the finding count exceeds `n`.
 *
 * DEFAULT-SAFE BY CONSTRUCTION: with an unset gate the exit code is EXACTLY
 * today's behavior — findings never fail the check on severity or volume alone.
 * Both knobs are opt-in; there is no severity default.
 */
import { Severity } from "@binclusive/a11y-contract";
import type { EnrichedFinding } from "./corpus";
import { contractSeverity } from "./emit-contract";

/**
 * The canonical severity ordering — most-severe first (`critical` < `major` <
 * `minor`) — read straight from the contract's own `Severity` enum. We source the
 * order from the enum's `.options` rather than hand-rolling a second rank map, so
 * the gate can never disagree with the contract's severity vocabulary.
 */
export const SEVERITY_ORDER: readonly Severity[] = Severity.options;

/** Rank of a severity in {@link SEVERITY_ORDER} — lower index = more severe. */
function severityRank(s: Severity): number {
  return SEVERITY_ORDER.indexOf(s);
}

/**
 * The opt-in blocking-gate config. Both fields default to `null` (unset) — the
 * default-safe state in which the gate never fails the check on findings alone.
 */
export interface GateConfig {
  readonly failOn: Severity | null;
  readonly maxViolations: number | null;
}

/** The unset (default-off) gate — the safe state the callers default to. */
export const GATE_OFF: GateConfig = { failOn: null, maxViolations: null };

/** The minimal per-finding projection the gate reasons over. */
export interface GateFinding {
  readonly severity: Severity;
  /** Whether the contract BLOCKS this finding (`enforcement === "block"`). */
  readonly blocking: boolean;
}

/** Project an enriched finding onto the gate's minimal shape. */
export function toGateFinding(f: EnrichedFinding): GateFinding {
  return { severity: contractSeverity(f), blocking: f.enforcement === "block" };
}

/**
 * The `check` command's exit code, honoring the opt-in gate.
 *
 * With an unset gate (`failOn` and `maxViolations` both `null`) the result is
 * today's behavior EXACTLY: non-zero iff a contract-blocking finding fired.
 *
 * When the gate IS set, the exit reflects the gate: non-zero when any finding is
 * at or above `failOn` (severity rank ≤ threshold rank), or when the finding
 * count exceeds `maxViolations`; zero otherwise.
 */
export function gateExitCode(findings: readonly GateFinding[], gate: GateConfig): number {
  const gated = gate.failOn !== null || gate.maxViolations !== null;
  if (!gated) {
    return findings.some((f) => f.blocking) ? 1 : 0;
  }
  if (gate.failOn !== null) {
    const threshold = severityRank(gate.failOn);
    if (findings.some((f) => severityRank(f.severity) <= threshold)) return 1;
  }
  if (gate.maxViolations !== null && findings.length > gate.maxViolations) return 1;
  return 0;
}
