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
import type { EnrichedFinding } from "./evidence";
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
 * The exit-policy config. Two independent overlays on the exit code:
 *
 * - `failOn` / `maxViolations` — the OPT-IN blocking gate (#2134). Both default
 *   to `null` (unset), the default-safe state in which the gate never fails the
 *   check on findings alone.
 * - `advisory` — the generic CI runner mode (#2236). When `true`, the run's
 *   BASELINE exit is 0 even when contract-blocking findings fired: the engine
 *   reports every finding but never fails the check by itself. This is the
 *   first-class non-blocking default a CI runner selects (via `check --ci`),
 *   replacing the old shell `|| true` swallow with an exit policy the engine
 *   owns. The opt-in gate still overrides in advisory mode — set `failOn` /
 *   `maxViolations` and the run fails when the threshold trips — so blocking
 *   stays available but is strictly opt-in.
 */
export interface GateConfig {
  readonly failOn: Severity | null;
  readonly maxViolations: number | null;
  readonly advisory: boolean;
}

/**
 * The default exit policy: blocking-on-contract-block, gate off. This is the
 * plain-CLI default — a local `check` still exits non-zero on a blocking finding.
 */
export const GATE_OFF: GateConfig = { failOn: null, maxViolations: null, advisory: false };

/**
 * The generic CI runner default (#2236): non-blocking baseline (exit 0 on any
 * findings) with no opt-in gate. `check --ci` selects this so any CI can consume
 * the SARIF/JSON artifact without the check failing; layering `failOn` /
 * `maxViolations` on top re-enables a failing exit.
 */
export const GATE_ADVISORY: GateConfig = { failOn: null, maxViolations: null, advisory: true };

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
 * today's behavior EXACTLY: non-zero iff a contract-blocking finding fired —
 * UNLESS `advisory` is set, in which case the baseline is 0 (the generic CI
 * runner mode, #2236: findings are reported but never fail the check on their
 * own).
 *
 * When the gate IS set, the exit reflects the gate: non-zero when any finding is
 * at or above `failOn` (severity rank ≤ threshold rank), or when the finding
 * count exceeds `maxViolations`; zero otherwise. The opt-in gate applies in
 * advisory mode too, so a CI runner can still opt into a failing exit.
 */
export function gateExitCode(findings: readonly GateFinding[], gate: GateConfig): number {
  const gated = gate.failOn !== null || gate.maxViolations !== null;
  if (!gated) {
    // Advisory baseline (#2236): non-blocking even with contract-blocking findings.
    if (gate.advisory) return 0;
    return findings.some((f) => f.blocking) ? 1 : 0;
  }
  if (gate.failOn !== null) {
    const threshold = severityRank(gate.failOn);
    if (findings.some((f) => severityRank(f.severity) <= threshold)) return 1;
  }
  if (gate.maxViolations !== null && findings.length > gate.maxViolations) return 1;
  return 0;
}
