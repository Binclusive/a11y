/**
 * baseline.ts — the Liquid real-world regression baseline: a committed snapshot of
 * the checker's results across the SHA-pinned Shopify-theme corpus, plus the diff
 * that turns the corpus into a regression gate.
 *
 * The corpus (manifest.json) is SHA-pinned, so the only thing that can move these
 * numbers is the Liquid checker's own code (L1 `liquid-ast.ts` + L2
 * `liquid-rules.ts`, via `scanLiquid`). The store / diff / bless skeleton is shared
 * (`experiments/_matrix/harness.ts`, #247); this dir owns only the snapshot SHAPE
 * (`toThemeBaseline`, which fixes the committed baseline.json key order) and its
 * secondary diff fields (`filesScanned` / `parseErrorCount`).
 *
 *   shopify:matrix:baseline   re-bless: read results/ → write baseline.json (sorted)
 *   shopify:matrix:check      re-scan + diff current vs baseline (see check.ts)
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type DiffResult, diffSnapshots, makeStore, runBless, sortByRuleRecord } from "../_matrix/harness.ts";
import type { ThemeResult } from "./run.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(HERE, "results");
export const BASELINE_PATH = join(HERE, "baseline.json");

/** The compact, committed snapshot of one theme's scan. Deterministic by design. */
export interface ThemeBaseline {
  readonly sha: string;
  readonly filesScanned: number;
  readonly findingsCount: number;
  readonly parseErrorCount: number;
  readonly parseErrorRate: number;
  readonly byRule: Record<string, number>;
  readonly findings: readonly { file: string; line: number; ruleId: string }[];
  readonly error: string | null;
}

export type Baseline = Record<string, ThemeBaseline>;

/** Distill one raw result into its committed snapshot. Owns the baseline key order. */
export function toThemeBaseline(r: ThemeResult): ThemeBaseline {
  return {
    sha: r.sha ?? "",
    filesScanned: r.filesScanned ?? 0,
    findingsCount: r.findingsCount ?? 0,
    parseErrorCount: r.parseErrorCount ?? 0,
    parseErrorRate: r.parseErrorRate ?? 0,
    byRule: sortByRuleRecord(r.byRule ?? {}),
    findings: (r.findings ?? []).map((f) => ({ file: f.file, line: f.line, ruleId: f.ruleId })),
    error: r.error ?? null,
  };
}

const store = makeStore<ThemeResult, ThemeBaseline>({ resultsDir: RESULTS_DIR, baselinePath: BASELINE_PATH, distill: toThemeBaseline });

export const loadResults = (): Record<string, ThemeResult> => store.loadResults();
export const loadBaseline = (): Baseline | null => store.loadBaseline();
export const writeBaseline = (b: Baseline): void => store.writeBaseline(b);
export const toBaseline = (results: Record<string, ThemeResult>): Baseline => store.toBaseline(results);

/** Snapshot-equality diff: findings + per-rule counts + SECONDARY files/parseErrors. */
export function diffBaseline(current: Baseline, baseline: Baseline): DiffResult {
  return diffSnapshots(current, baseline, {
    findingsOf: (s) => s.findingsCount,
    byRuleOf: (s) => s.byRule,
    errorOf: (s) => s.error,
    secondary: [
      { key: "files", get: (s) => s.filesScanned },
      { key: "parseErrors", get: (s) => s.parseErrorCount },
    ],
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runBless({
    store,
    baselinePath: BASELINE_PATH,
    messages: {
      empty: "No results/*.json found. Run `pnpm shopify:matrix:run` first.",
      wrote: (count, path) => `Wrote baseline.json for ${count} theme(s) → ${path}`,
    },
  });
}
