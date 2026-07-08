/**
 * baseline.ts — the Unity real-world regression baseline: a committed snapshot of
 * the producer's results across the SHA-pinned Unity corpus, plus the diff that
 * turns the corpus into a regression gate.
 *
 * The corpus (manifest.json) is SHA-pinned, so the only thing that can move these
 * numbers is the Unity checker's own code — the producer (`scanUnity`: `unity-ast.ts`
 * + `collect-unity.ts` + `unity-guid-registry.ts`) AND the finding rules the #88
 * aggregator (`collectUnityFindings`) runs. The store / diff / bless skeleton is
 * shared (`experiments/_matrix/harness.ts`, #247); this dir owns only the snapshot
 * SHAPE (`toRepoBaseline`) and its secondary diff fields.
 *
 * The PRIMARY gated quantity is the FINDING stream (`findingsCount` / `byRule` /
 * `findings`). Per-asset PARSE OUTCOME — graph vs opaque(binary)/opaque(parse) — is
 * kept as a SECONDARY assertion so Force-Text detection stays committed and
 * drift-visible (ADR 0004); the opaque counts are diffed.
 *
 *   unity:matrix:baseline   re-bless: read results/ → write baseline.json (sorted)
 *   unity:matrix:check      re-scan + diff current vs baseline (see check.ts)
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type DiffResult, diffSnapshots, makeStore, runBless, sortByRuleRecord } from "../_matrix/harness.ts";
import type { UnityResult } from "./run.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(HERE, "results");
export const BASELINE_PATH = join(HERE, "baseline.json");

/** The compact, committed snapshot of one repo's scan. Deterministic by design.
 * `findings` is the sorted full list; `opaqueAssets` keeps the same property for
 * the secondary parse-outcome assertion. */
export interface RepoBaseline {
  readonly sha: string;
  readonly findingsCount: number;
  readonly byRule: Record<string, number>;
  readonly findings: readonly { file: string; line: number; ruleId: string }[];
  readonly assetsScanned: number;
  readonly graphCount: number;
  readonly opaqueBinary: number;
  readonly opaqueParseError: number;
  readonly opaqueRate: number;
  readonly opaqueAssets: readonly { file: string; reason: string }[];
  readonly error: string | null;
}

export type Baseline = Record<string, RepoBaseline>;

/** Distill one raw result into its committed snapshot. Owns the baseline key order. */
export function toRepoBaseline(r: UnityResult): RepoBaseline {
  return {
    sha: r.sha ?? "",
    findingsCount: r.findingsCount ?? 0,
    byRule: sortByRuleRecord(r.byRule ?? {}),
    findings: (r.findings ?? []).map((f) => ({ file: f.file, line: f.line, ruleId: f.ruleId })),
    assetsScanned: r.assetsScanned ?? 0,
    graphCount: r.graphCount ?? 0,
    opaqueBinary: r.opaqueBinary ?? 0,
    opaqueParseError: r.opaqueParseError ?? 0,
    opaqueRate: r.opaqueRate ?? 0,
    opaqueAssets: (r.opaqueAssets ?? []).map((a) => ({ file: a.file, reason: a.reason })),
    error: r.error ?? null,
  };
}

const store = makeStore<UnityResult, RepoBaseline>({ resultsDir: RESULTS_DIR, baselinePath: BASELINE_PATH, distill: toRepoBaseline });

export const loadResults = (): Record<string, UnityResult> => store.loadResults();
export const loadBaseline = (): Baseline | null => store.loadBaseline();
export const writeBaseline = (b: Baseline): void => store.writeBaseline(b);
export const toBaseline = (results: Record<string, UnityResult>): Baseline => store.toBaseline(results);

/** Snapshot-equality diff: findings + per-rule counts + SECONDARY assets/graph/opaque. */
export function diffBaseline(current: Baseline, baseline: Baseline): DiffResult {
  return diffSnapshots(current, baseline, {
    findingsOf: (s) => s.findingsCount,
    byRuleOf: (s) => s.byRule,
    errorOf: (s) => s.error,
    secondary: [
      { key: "assets", get: (s) => s.assetsScanned },
      { key: "graph", get: (s) => s.graphCount },
      { key: "opaqueBinary", get: (s) => s.opaqueBinary },
      { key: "opaqueParseError", get: (s) => s.opaqueParseError },
    ],
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runBless({
    store,
    baselinePath: BASELINE_PATH,
    messages: {
      empty: "No results/*.json found. Run `pnpm unity:matrix:run` first.",
      wrote: (count, path) => `Wrote baseline.json for ${count} repo(s) → ${path}`,
    },
  });
}
