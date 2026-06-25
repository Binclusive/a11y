/**
 * baseline.ts — the Unity real-world regression baseline: a committed snapshot of
 * the producer's results across the SHA-pinned Unity corpus, plus the diff that
 * turns the corpus into a regression gate.
 *
 * Unity analog of `experiments/shopify-matrix/baseline.ts`. The corpus
 * (manifest.json) is SHA-pinned, so the only thing that can move these numbers is
 * the Unity checker's own code — the producer (`scanUnity`: L1 `unity-ast.ts` + L3
 * `collect-unity.ts` + `unity-guid-registry.ts`) AND the finding rules the #88
 * aggregator (`collectUnityFindings`) runs (`unity-rule-color-only.ts`,
 * `unity-rule-missing-label.ts`, `unity-rules-baseline.ts`). We distill each
 * per-repo result into a compact, deterministic record and commit it as
 * `baseline.json`. Every change that shifts real-world Unity behavior must show up
 * as an edit to that file in the PR — silent drift becomes a visible diff.
 *
 * The PRIMARY gated quantity is the FINDING stream (`findingsCount` / `byRule` /
 * `findings`) — mirroring `shopify-matrix`, now that the producer emits findings
 * (#88/#90). Per-asset PARSE OUTCOME — graph vs opaque(binary)/opaque(parse) — is
 * kept as a SECONDARY assertion so Force-Text detection stays committed and
 * drift-visible (ADR 0004: opaque is reported, not silently skipped); the opaque
 * fields are still diffed.
 *
 *   unity:matrix:baseline   re-bless: read results/ → write baseline.json (sorted)
 *   unity:matrix:check      re-scan + diff current vs baseline (see check.ts)
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { UnityResult } from "./run.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(HERE, "results");
export const BASELINE_PATH = join(HERE, "baseline.json");

/** The compact, committed snapshot of one repo's scan. Deterministic by design.
 * `findings` is the sorted full list so a moved/added/removed finding is a
 * line-level, reviewable diff — not just an aggregate count change; `opaqueAssets`
 * keeps the same property for the secondary parse-outcome assertion. */
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

/** repo -> snapshot. Serialized with keys sorted so git diffs are readable. */
export type Baseline = Record<string, RepoBaseline>;

/** Read every results/*.json into a repo-keyed map of raw results. */
export function loadResults(): Record<string, UnityResult> {
  const out: Record<string, UnityResult> = {};
  if (!existsSync(RESULTS_DIR)) return out;
  for (const file of readdirSync(RESULTS_DIR)) {
    if (!file.endsWith(".json")) continue;
    const raw = JSON.parse(readFileSync(join(RESULTS_DIR, file), "utf8")) as UnityResult;
    if (raw.repo) out[raw.repo] = raw;
  }
  return out;
}

function sortByRule(byRule: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of Object.keys(byRule).sort()) out[id] = byRule[id];
  return out;
}

/** Distill one raw result into its committed snapshot. */
export function toRepoBaseline(r: UnityResult): RepoBaseline {
  return {
    sha: r.sha ?? "",
    findingsCount: r.findingsCount ?? 0,
    byRule: sortByRule(r.byRule ?? {}),
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

/** Build a full baseline from a raw-results map, keys sorted for stable output. */
export function toBaseline(results: Record<string, UnityResult>): Baseline {
  const out: Baseline = {};
  for (const repo of Object.keys(results).sort()) out[repo] = toRepoBaseline(results[repo]);
  return out;
}

export function loadBaseline(): Baseline | null {
  if (!existsSync(BASELINE_PATH)) return null;
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;
}

export function writeBaseline(b: Baseline): void {
  writeFileSync(BASELINE_PATH, JSON.stringify(b, null, 2) + "\n");
}

// --- diff -------------------------------------------------------------------

export interface RuleDelta {
  readonly ruleId: string;
  readonly before: number;
  readonly after: number;
}

/** One repo whose snapshot moved between baseline and current. */
export interface RepoDelta {
  readonly repo: string;
  readonly kind: "added" | "removed" | "changed";
  readonly findings?: { before: number; after: number };
  readonly assets?: { before: number; after: number };
  readonly graph?: { before: number; after: number };
  readonly opaqueBinary?: { before: number; after: number };
  readonly opaqueParseError?: { before: number; after: number };
  readonly errorChange?: { before: string | null; after: string | null };
  readonly rules: readonly RuleDelta[];
}

export interface DiffResult {
  readonly deltas: readonly RepoDelta[];
  readonly unchanged: number;
}

function ruleDeltas(before: Record<string, number>, after: Record<string, number>): RuleDelta[] {
  const ids = new Set([...Object.keys(before), ...Object.keys(after)]);
  const out: RuleDelta[] = [];
  for (const ruleId of [...ids].sort()) {
    const b = before[ruleId] ?? 0;
    const a = after[ruleId] ?? 0;
    if (b !== a) out.push({ ruleId, before: b, after: a });
  }
  return out;
}

/**
 * Compare a current snapshot against the committed baseline. Snapshot-equality:
 * ANY movement — primary (findings count, per-rule counts) or secondary (assets
 * scanned, graph count, opaque-by-reason counts, error transition) — is surfaced.
 * The caller decides intended-vs-regression and re-blesses; the gate's job is only
 * to make movement impossible to miss.
 */
export function diffBaseline(current: Baseline, baseline: Baseline): DiffResult {
  const repos = new Set([...Object.keys(baseline), ...Object.keys(current)]);
  const deltas: RepoDelta[] = [];
  let unchanged = 0;

  for (const repo of [...repos].sort()) {
    const base = baseline[repo];
    const cur = current[repo];

    if (!base) {
      deltas.push({ repo, kind: "added", findings: { before: 0, after: cur.findingsCount }, rules: [] });
      continue;
    }
    if (!cur) {
      deltas.push({ repo, kind: "removed", findings: { before: base.findingsCount, after: 0 }, rules: [] });
      continue;
    }

    const rules = ruleDeltas(base.byRule, cur.byRule);
    const findingsMoved = base.findingsCount !== cur.findingsCount;
    const assetsMoved = base.assetsScanned !== cur.assetsScanned;
    const graphMoved = base.graphCount !== cur.graphCount;
    const binMoved = base.opaqueBinary !== cur.opaqueBinary;
    const parseMoved = base.opaqueParseError !== cur.opaqueParseError;
    const errorMoved = (base.error ?? null) !== (cur.error ?? null);

    if (!findingsMoved && !assetsMoved && !graphMoved && !binMoved && !parseMoved && !errorMoved && rules.length === 0) {
      unchanged++;
      continue;
    }
    deltas.push({
      repo,
      kind: "changed",
      ...(findingsMoved ? { findings: { before: base.findingsCount, after: cur.findingsCount } } : {}),
      ...(assetsMoved ? { assets: { before: base.assetsScanned, after: cur.assetsScanned } } : {}),
      ...(graphMoved ? { graph: { before: base.graphCount, after: cur.graphCount } } : {}),
      ...(binMoved ? { opaqueBinary: { before: base.opaqueBinary, after: cur.opaqueBinary } } : {}),
      ...(parseMoved ? { opaqueParseError: { before: base.opaqueParseError, after: cur.opaqueParseError } } : {}),
      ...(errorMoved ? { errorChange: { before: base.error, after: cur.error } } : {}),
      rules,
    });
  }
  return { deltas, unchanged };
}

// --- unity:matrix:baseline (re-bless) ---------------------------------------

function main(): void {
  const results = loadResults();
  const count = Object.keys(results).length;
  if (count === 0) {
    console.error("No results/*.json found. Run `pnpm unity:matrix:run` first.");
    process.exit(1);
  }
  writeBaseline(toBaseline(results));
  console.log(`Wrote baseline.json for ${count} repo(s) → ${BASELINE_PATH}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
