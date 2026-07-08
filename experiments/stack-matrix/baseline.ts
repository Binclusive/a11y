/**
 * baseline.ts — the real-world regression baseline: a committed snapshot of the
 * checker's results across the pinned repo corpus, plus the diff that turns the
 * benchmark into a regression gate.
 *
 * The corpus (manifest.json) is SHA-pinned, so the only thing that can move these
 * numbers is the checker's own code. The store / diff / bless skeleton is shared
 * (`experiments/_matrix/harness.ts`, #247); this dir owns only the snapshot SHAPE
 * (`toRepoBaseline`, which fixes the committed baseline.json key order) and its
 * secondary diff field (`coverage.checked`). Every change that shifts real-world
 * behavior must show up as an edit to baseline.json in the PR — silent drift
 * becomes a visible diff in review.
 *
 *   matrix:baseline   re-bless: read results/ → write baseline.json (sorted)
 *   matrix:check      re-scan + diff current vs baseline (see check.ts)
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { byRuleOf, type DiffResult, diffSnapshots, makeStore, runBless } from "../_matrix/harness.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(HERE, "results");
export const BASELINE_PATH = join(HERE, "baseline.json");

interface Finding {
  ruleId: string;
}

/** The raw per-repo result written by run.ts (only the fields we snapshot). */
interface RawResult {
  repo: string;
  sha?: string;
  /** Whether the clone is parked at the manifest sha. false ⇒ delta may be drift. */
  pinned?: boolean;
  coverage?: { checked: number; trusted: number; declare: number; icons: number; structural: number; total: number };
  findings?: Finding[];
  summary?: { findings: number; blocking: number; warning: number };
  error?: string | null;
}

/** The compact, committed snapshot of one repo's scan. Deterministic by design. */
export interface RepoBaseline {
  readonly sha: string;
  readonly findings: number;
  readonly blocking: number;
  readonly warning: number;
  readonly coverage: { checked: number; trusted: number; declare: number; icons: number; structural: number; total: number };
  /** ruleId -> count, so a diff can say "alt-text +3" not just "findings +3". */
  readonly byRule: Record<string, number>;
  readonly error: string | null;
}

export type Baseline = Record<string, RepoBaseline>;

const ZERO_COVERAGE = { checked: 0, trusted: 0, declare: 0, icons: 0, structural: 0, total: 0 };

/** Distill one raw result into its committed snapshot. Owns the baseline key order. */
export function toRepoBaseline(r: RawResult): RepoBaseline {
  return {
    sha: r.sha ?? "",
    findings: r.summary?.findings ?? 0,
    blocking: r.summary?.blocking ?? 0,
    warning: r.summary?.warning ?? 0,
    coverage: r.coverage ?? { ...ZERO_COVERAGE },
    byRule: byRuleOf(r.findings ?? []),
    error: r.error ?? null,
  };
}

const store = makeStore<RawResult, RepoBaseline>({ resultsDir: RESULTS_DIR, baselinePath: BASELINE_PATH, distill: toRepoBaseline });

export const loadResults = (): Record<string, RawResult> => store.loadResults();
export const loadBaseline = (): Baseline | null => store.loadBaseline();
export const writeBaseline = (b: Baseline): void => store.writeBaseline(b);
export const toBaseline = (results: Record<string, RawResult>): Baseline => store.toBaseline(results);

/** Snapshot-equality diff: findings + per-rule counts + SECONDARY coverage.checked. */
export function diffBaseline(current: Baseline, baseline: Baseline): DiffResult {
  return diffSnapshots(current, baseline, {
    findingsOf: (s) => s.findings,
    byRuleOf: (s) => s.byRule,
    errorOf: (s) => s.error,
    secondary: [{ key: "checked", get: (s) => s.coverage.checked }],
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runBless({
    store,
    baselinePath: BASELINE_PATH,
    messages: {
      empty: "No results/*.json found. Run `pnpm matrix:run` first.",
      wrote: (count, path) => `Wrote baseline.json for ${count} repos → ${path}`,
    },
  });
}
