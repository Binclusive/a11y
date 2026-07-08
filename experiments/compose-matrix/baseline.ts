/**
 * baseline.ts — the Compose real-world regression baseline: a committed snapshot of
 * the engine's results across the SHA-pinned Jetpack Compose corpus, plus the diff
 * that turns the corpus into a regression gate.
 *
 * The corpus (manifest.json) is SHA-pinned, so the only thing that can move these
 * numbers is the Compose checker's own code — the TS boundary
 * (`src/collect-kotlin.ts`) plus the out-of-process Kotlin PSI engine
 * (`kotlin/A11yKotlinScan/`, rule `compose/image-no-label`; ADR 0008). The store /
 * diff / bless skeleton is shared (`experiments/_matrix/harness.ts`, #247); this
 * dir owns only the snapshot SHAPE (`toRepoBaseline`) and its diff fields — findings
 * only, no secondary parse-outcome layer.
 *
 *   compose:matrix:baseline   re-bless: read results/ → write baseline.json (sorted)
 *   compose:matrix:check      re-scan + diff current vs baseline (see check.ts)
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type DiffResult, diffSnapshots, makeStore, runBless, sortByRuleRecord } from "../_matrix/harness.ts";
import type { ComposeResult } from "./run.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(HERE, "results");
export const BASELINE_PATH = join(HERE, "baseline.json");

/** The compact, committed snapshot of one repo's scan. Deterministic by design. */
export interface RepoBaseline {
  readonly sha: string;
  readonly findingsCount: number;
  readonly byRule: Record<string, number>;
  readonly findings: readonly { file: string; line: number; ruleId: string }[];
  readonly error: string | null;
}

export type Baseline = Record<string, RepoBaseline>;

/** Distill one raw result into its committed snapshot. Owns the baseline key order. */
export function toRepoBaseline(r: ComposeResult): RepoBaseline {
  return {
    sha: r.sha ?? "",
    findingsCount: r.findingsCount ?? 0,
    byRule: sortByRuleRecord(r.byRule ?? {}),
    findings: (r.findings ?? []).map((f) => ({ file: f.file, line: f.line, ruleId: f.ruleId })),
    error: r.error ?? null,
  };
}

const store = makeStore<ComposeResult, RepoBaseline>({ resultsDir: RESULTS_DIR, baselinePath: BASELINE_PATH, distill: toRepoBaseline });

export const loadResults = (): Record<string, ComposeResult> => store.loadResults();
export const loadBaseline = (): Baseline | null => store.loadBaseline();
export const writeBaseline = (b: Baseline): void => store.writeBaseline(b);
export const toBaseline = (results: Record<string, ComposeResult>): Baseline => store.toBaseline(results);

/** Snapshot-equality diff: findings + per-rule counts (no secondary layer). */
export function diffBaseline(current: Baseline, baseline: Baseline): DiffResult {
  return diffSnapshots(current, baseline, {
    findingsOf: (s) => s.findingsCount,
    byRuleOf: (s) => s.byRule,
    errorOf: (s) => s.error,
    secondary: [],
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runBless({
    store,
    baselinePath: BASELINE_PATH,
    messages: {
      empty: "No results/*.json found. Run `pnpm compose:matrix:run` first.",
      wrote: (count, path) => `Wrote baseline.json for ${count} repo(s) → ${path}`,
    },
  });
}
