/**
 * `recall:eval` — the measurement harness for the corpus-recall layer (RFC Phase
 * 1, §1f). It scores a set of per-fixture NOMINATIONS through the REAL
 * `reviewA11y` verify gate stack (G0-G8) and reports precision (Wilson lower
 * bound) + recall over the labelled {@link CASES}.
 *
 * THE GROUNDING IS A PLUGGABLE INPUT. The runner itself NEVER calls a model — it
 * takes a {@link Nominations} map (`fixtureId -> ReviewCandidate[]`) as input, so
 * the harness is deterministic and unit-testable. The later MANUAL grounded run
 * feeds this map with real model nominations; the unit tests feed it synthetic
 * ones. Either way the candidates flow through the EXACT shipped path
 * (`reviewA11y({ verify })`), so the eval certifies the deployed channel, not a
 * proxy.
 *
 * Scoring (RFC §1f):
 *   - precision = correct-surfaced / total-surfaced, reported as a WILSON LOWER
 *     BOUND over the aggregate (a small sample must not flake the gate).
 *   - recall    = caught-positives / total-positives, reported + soft-floored.
 *
 * The PASS gate (decision: locked) is precision Wilson-lower-bound >= 0.95.
 * Recall is reported only — never fails the gate.
 *
 * A SURFACED finding is "correct" iff it lands on a POSITIVE fixture AND matches
 * an expected `(patternId, line)`. Any finding surfaced on a NEGATIVE fixture, or
 * an unexpected one on a positive, is a false positive — exactly the precision
 * leak the gate guards.
 */

import { resolve } from "node:path";
import type { ReviewCandidate } from "../../src/review";
import { reviewA11y } from "../../src/review";
import { CASES, type LabelledCase } from "./case-set";

/**
 * The pluggable grounding input: per-fixture nominations keyed by {@link
 * LabelledCase.id}. This is what the manual grounded run feeds with real model
 * output and what the tests feed with synthetic candidates. A fixture absent from
 * the map (or mapped to `[]`) is "the agent nominated nothing here" — correct for
 * a clean negative, a missed positive otherwise.
 */
export type Nominations = Readonly<Record<string, readonly ReviewCandidate[]>>;

/** A surfaced recall finding flattened to the (file, line, patternId) it asserts. */
interface SurfacedFinding {
  readonly caseId: string;
  readonly line: number;
  readonly patternId: string;
  /** True iff this surfaced finding matches an expected finding on a positive. */
  readonly correct: boolean;
}

/** Per-case scoring outcome — what surfaced and whether the label was satisfied. */
export interface CaseResult {
  readonly id: string;
  readonly kind: LabelledCase["kind"];
  /** Recall findings the gate stack let through for this case. */
  readonly surfaced: readonly SurfacedFinding[];
  /** Expected findings (positives only) that were caught. */
  readonly caught: number;
  /** Expected findings total (positives only; 0 for negatives). */
  readonly expected: number;
}

/** The aggregate eval report — the numbers the gate reads. */
export interface EvalReport {
  readonly cases: readonly CaseResult[];
  /** Total recall findings surfaced across all cases (precision denominator). */
  readonly surfacedTotal: number;
  /** Surfaced findings that were correct (precision numerator). */
  readonly surfacedCorrect: number;
  /** Point-estimate precision (correct / surfaced); 1 when nothing surfaced. */
  readonly precision: number;
  /** Wilson 95% lower bound on precision — the gate input. */
  readonly precisionWilsonLower: number;
  /** Total expected positives across all positive cases (recall denominator). */
  readonly expectedTotal: number;
  /** Expected positives caught (recall numerator). */
  readonly caughtTotal: number;
  /** Point-estimate recall (caught / expected); 1 when nothing was expected. */
  readonly recall: number;
  /** Whether precisionWilsonLower clears {@link PRECISION_FLOOR}. */
  readonly pass: boolean;
}

/** The locked precision gate (RFC resolved decision 1): Wilson lower bound >= this. */
export const PRECISION_FLOOR = 0.95;

/** The z for a 95% one-sided/two-sided Wilson interval (1.959964 ≈ Φ⁻¹(0.975)). */
const WILSON_Z = 1.959964;

/**
 * Wilson score-interval LOWER bound for a binomial proportion — the precision
 * gate input (RFC §1f). Unlike the point estimate `correct/total`, the Wilson
 * lower bound is honest about a small sample: 4/4 yields ~0.51, not 1.0, so a
 * lucky-but-tiny run cannot clear a 0.95 gate. As the sample grows the bound
 * tightens toward the point estimate. With `total === 0` precision is vacuously
 * perfect, so we return 1 (nothing surfaced ⇒ no precision leak to bound).
 *
 *   lower = (p̂ + z²/2n − z·√[ (p̂(1−p̂) + z²/4n) / n ]) / (1 + z²/n)
 */
export function wilsonLowerBound(correct: number, total: number, z: number = WILSON_Z): number {
  if (total === 0) return 1;
  const phat = correct / total;
  const z2 = z * z;
  const denom = 1 + z2 / total;
  const centre = phat + z2 / (2 * total);
  const margin = z * Math.sqrt((phat * (1 - phat) + z2 / (4 * total)) / total);
  const lower = (centre - margin) / denom;
  return lower < 0 ? 0 : lower;
}

/**
 * Whether a surfaced `(line, patternId)` matches one of a positive case's
 * expected findings. Patterns and lines must both match — a right pattern on the
 * wrong line (or vice versa) is a false positive, not a catch.
 */
function isExpected(c: LabelledCase, line: number, patternId: string): boolean {
  if (c.kind !== "positive") return false;
  return c.expect.some((e) => e.line === line && e.patternId === patternId);
}

/**
 * Run ONE labelled case's nominations through the real verify gate stack and
 * score the survivors against the case label. Pure over (case, candidates):
 * `reviewA11y({ verify })` is the deterministic shell, so same input → same
 * result.
 *
 * The files array is the case file PLUS every unique file the candidates point at
 * — the scan-a-directory shape (#6), not one-file-per-candidate. (Wrapper
 * definition files do not need to be listed: the source-tracer follows the import
 * and reads the def off disk, so the resolved-host suppressors fire from the
 * trace regardless.) Survivors are scored only on the CASE file.
 */
async function runCase(
  c: LabelledCase,
  candidates: readonly ReviewCandidate[],
): Promise<CaseResult> {
  // Unique union, case file first, in a stable order so the scan is reproducible.
  const files = [...new Set([c.file, ...candidates.map((cand) => cand.file)])];
  const r = await reviewA11y({ verify: true, files, candidates: [...candidates] });
  if (r.mode !== "verify") throw new Error("expected verify mode");

  // Score survivors by file: only findings anchored to THIS case's file count
  // toward its label (a `recall` finding shaped from a candidate keeps the
  // candidate's `file`, which the synthetic/real nominations set to the case file).
  const surfaced: SurfacedFinding[] = r.recall
    .filter((f) => resolve(f.file) === resolve(c.file))
    .map((f) => ({
      caseId: c.id,
      line: f.line,
      patternId: f.patternId ?? "",
      correct: isExpected(c, f.line, f.patternId ?? ""),
    }));

  const expected = c.kind === "positive" ? c.expect.length : 0;
  // A positive is "caught" per expected finding that some surfaced finding matched.
  const caught =
    c.kind === "positive"
      ? c.expect.filter((e) =>
          surfaced.some((s) => s.line === e.line && s.patternId === e.patternId),
        ).length
      : 0;

  return { id: c.id, kind: c.kind, surfaced, caught, expected };
}

/**
 * Run the full labelled set through the gate stack with the supplied nominations
 * and produce the aggregate report. The nominations map is the pluggable
 * grounding input — synthetic in tests, real-model in the manual run.
 */
export async function runEval(nominations: Nominations): Promise<EvalReport> {
  const cases: CaseResult[] = [];
  for (const c of CASES) {
    cases.push(await runCase(c, nominations[c.id] ?? []));
  }

  let surfacedTotal = 0;
  let surfacedCorrect = 0;
  let expectedTotal = 0;
  let caughtTotal = 0;
  for (const r of cases) {
    surfacedTotal += r.surfaced.length;
    surfacedCorrect += r.surfaced.filter((s) => s.correct).length;
    expectedTotal += r.expected;
    caughtTotal += r.caught;
  }

  const precision = surfacedTotal === 0 ? 1 : surfacedCorrect / surfacedTotal;
  const precisionWilsonLower = wilsonLowerBound(surfacedCorrect, surfacedTotal);
  const recall = expectedTotal === 0 ? 1 : caughtTotal / expectedTotal;

  return {
    cases,
    surfacedTotal,
    surfacedCorrect,
    precision,
    precisionWilsonLower,
    expectedTotal,
    caughtTotal,
    recall,
    pass: precisionWilsonLower >= PRECISION_FLOOR,
  };
}

/**
 * Format the report as a compact, human-readable block for the CLI. Leads with
 * the gate verdict, then the two headline numbers, then a per-case line so a
 * precision leak is traceable to the fixture that produced it.
 */
export function formatReport(report: EvalReport): string {
  const lines: string[] = [];
  const verdict = report.pass ? "PASS" : "FAIL";
  lines.push(`recall:eval ${verdict}  (precision gate: Wilson lower bound >= ${PRECISION_FLOOR})`);
  lines.push("");
  lines.push(
    `  precision        ${report.precision.toFixed(3)}  (${report.surfacedCorrect}/${report.surfacedTotal} surfaced correct)`,
  );
  lines.push(
    `  precision Wilson ${report.precisionWilsonLower.toFixed(3)}  <- the gate input`,
  );
  lines.push(
    `  recall           ${report.recall.toFixed(3)}  (${report.caughtTotal}/${report.expectedTotal} positives caught)  [reported, soft-floored]`,
  );
  lines.push("");
  for (const c of report.cases) {
    const fp = c.surfaced.filter((s) => !s.correct).length;
    const tag =
      c.kind === "positive"
        ? `caught ${c.caught}/${c.expected}${fp > 0 ? `, ${fp} FP` : ""}`
        : c.surfaced.length === 0
          ? "clean"
          : `${c.surfaced.length} FP`;
    const flag = fp > 0 || (c.kind === "positive" && c.caught < c.expected) ? " <--" : "";
    lines.push(`    ${c.id.padEnd(40)} ${tag}${flag}`);
  }
  return lines.join("\n");
}

/**
 * CLI entry. With NO grounding wired in (the model run is manual), there are no
 * nominations to score, so the harness reports the EMPTY-nomination baseline:
 * nothing surfaces, precision is vacuously 1.0 (PASS), recall is 0. This proves
 * the wiring end-to-end and is the honest state until the manual grounded run
 * supplies a real {@link Nominations} map (see the README). Exits non-zero only
 * if the precision gate fails — never on low recall.
 */
async function main(): Promise<void> {
  const report = await runEval({});
  // eslint-disable-next-line no-console
  console.log(formatReport(report));
  // eslint-disable-next-line no-console
  console.log(
    "\nNote: no model nominations wired in — this is the empty-nomination baseline.",
  );
  // eslint-disable-next-line no-console
  console.log(
    "The real grounded run feeds runEval() a { fixtureId -> nominations[] } map (see README.md).",
  );
  if (!report.pass) process.exitCode = 1;
}

// Run when invoked directly (`pnpm recall:eval`).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error(err instanceof Error ? err.stack : String(err));
    process.exitCode = 1;
  });
}
