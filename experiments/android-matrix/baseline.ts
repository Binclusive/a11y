/**
 * baseline.ts — the Android real-world regression baseline: a committed snapshot
 * of the collector's results across the SHA-pinned Android corpus, plus the diff
 * that turns the corpus into a regression gate.
 *
 * Android analog of `experiments/unity-matrix/baseline.ts`. The corpus
 * (manifest.json) is SHA-pinned, so the only thing that can move these numbers is
 * the Android checker's own code (`src/collect-android-xml.ts`). The store / diff /
 * bless skeleton is shared with every matrix gate (`experiments/_matrix/harness.ts`,
 * #247); this dir owns only the snapshot SHAPE (`toRepoBaseline`, which fixes the
 * committed baseline.json key order) and its secondary diff fields.
 *
 * The gated quantity is the FINDING stream (`findingsCount` / `byRule` /
 * `findings`) plus SECONDARY parse coverage (`filesScanned` / `parseErrors`).
 *
 *   android:matrix:baseline   re-bless: read results/ → write baseline.json (sorted)
 *   android:matrix:check      re-scan + diff current vs baseline (see check.ts)
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type DiffResult, diffSnapshots, makeStore, runBless, sortByRuleRecord } from "../_matrix/harness.ts";
import type { AndroidResult } from "./run.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(HERE, "results");
export const BASELINE_PATH = join(HERE, "baseline.json");

/** The compact, committed snapshot of one repo's scan. Deterministic by design. */
export interface RepoBaseline {
  readonly sha: string;
  readonly findingsCount: number;
  readonly byRule: Record<string, number>;
  readonly findings: readonly { file: string; line: number; ruleId: string }[];
  readonly filesScanned: number;
  readonly parseErrors: number;
  readonly error: string | null;
}

export type Baseline = Record<string, RepoBaseline>;

/** Distill one raw result into its committed snapshot. Owns the baseline key order. */
export function toRepoBaseline(r: AndroidResult): RepoBaseline {
  return {
    sha: r.sha ?? "",
    findingsCount: r.findingsCount ?? 0,
    byRule: sortByRuleRecord(r.byRule ?? {}),
    findings: (r.findings ?? []).map((f) => ({ file: f.file, line: f.line, ruleId: f.ruleId })),
    filesScanned: r.filesScanned ?? 0,
    parseErrors: r.parseErrors ?? 0,
    error: r.error ?? null,
  };
}

const store = makeStore<AndroidResult, RepoBaseline>({ resultsDir: RESULTS_DIR, baselinePath: BASELINE_PATH, distill: toRepoBaseline });

export const loadResults = (): Record<string, AndroidResult> => store.loadResults();
export const loadBaseline = (): Baseline | null => store.loadBaseline();
export const writeBaseline = (b: Baseline): void => store.writeBaseline(b);
export const toBaseline = (results: Record<string, AndroidResult>): Baseline => store.toBaseline(results);

/** Snapshot-equality diff: findings + per-rule counts + SECONDARY files/parseErrors. */
export function diffBaseline(current: Baseline, baseline: Baseline): DiffResult {
  return diffSnapshots(current, baseline, {
    findingsOf: (s) => s.findingsCount,
    byRuleOf: (s) => s.byRule,
    errorOf: (s) => s.error,
    secondary: [
      { key: "files", get: (s) => s.filesScanned },
      { key: "parseErrors", get: (s) => s.parseErrors },
    ],
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runBless({
    store,
    baselinePath: BASELINE_PATH,
    messages: {
      empty: "No results/*.json found. Run `pnpm android:matrix:run` first.",
      wrote: (count, path) => `Wrote baseline.json for ${count} repo(s) → ${path}`,
    },
  });
}
