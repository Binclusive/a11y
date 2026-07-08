/**
 * baseline.ts — the Compose real-world regression baseline: a committed snapshot of
 * the Compose engine's results across the SHA-pinned Compose corpus, plus the diff
 * that turns the corpus into a regression gate.
 *
 * Compose analog of `experiments/unity-matrix/baseline.ts`. The corpus
 * (manifest.json) is SHA-pinned, so the only thing that can move these numbers is
 * the Compose checker's own code — the out-of-process Kotlin PSI engine
 * (`kotlin/A11yKotlinScan/`, rule `compose/image-no-label`) and its TS boundary
 * (`src/collect-kotlin.ts`, `scanKotlin`). We distill each per-repo result into a
 * compact, deterministic record and commit it as `baseline.json`. Every change that
 * shifts real-world Compose behavior must show up as an edit to that file in the PR —
 * silent drift becomes a visible diff.
 *
 * The gated quantity is the FINDING stream (`findingsCount` / `byRule` / `findings`);
 * the Compose engine emits findings only, so there is no secondary parse-outcome
 * layer (unlike unity-matrix).
 *
 *   compose:matrix:baseline   re-bless: read results/ → write baseline.json (sorted)
 *   compose:matrix:check      re-scan + diff current vs baseline (see check.ts)
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ComposeResult } from "./run.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(HERE, "results");
export const BASELINE_PATH = join(HERE, "baseline.json");

/** The compact, committed snapshot of one repo's scan. Deterministic by design.
 * `findings` is the sorted full list so a moved/added/removed finding is a
 * line-level, reviewable diff — not just an aggregate count change. */
export interface RepoBaseline {
  readonly sha: string;
  readonly findingsCount: number;
  readonly byRule: Record<string, number>;
  readonly findings: readonly { file: string; line: number; ruleId: string }[];
  readonly error: string | null;
}

/** repo -> snapshot. Serialized with keys sorted so git diffs are readable. */
export type Baseline = Record<string, RepoBaseline>;

/** Read every results/*.json into a repo-keyed map of raw results. */
export function loadResults(): Record<string, ComposeResult> {
  const out: Record<string, ComposeResult> = {};
  if (!existsSync(RESULTS_DIR)) return out;
  for (const file of readdirSync(RESULTS_DIR)) {
    if (!file.endsWith(".json")) continue;
    const raw = JSON.parse(readFileSync(join(RESULTS_DIR, file), "utf8")) as ComposeResult;
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
export function toRepoBaseline(r: ComposeResult): RepoBaseline {
  return {
    sha: r.sha ?? "",
    findingsCount: r.findingsCount ?? 0,
    byRule: sortByRule(r.byRule ?? {}),
    findings: (r.findings ?? []).map((f) => ({ file: f.file, line: f.line, ruleId: f.ruleId })),
    error: r.error ?? null,
  };
}

/** Build a full baseline from a raw-results map, keys sorted for stable output. */
export function toBaseline(results: Record<string, ComposeResult>): Baseline {
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
 * ANY movement — findings count, per-rule counts, or an error transition — is
 * surfaced. The caller decides intended-vs-regression and re-blesses; the gate's job
 * is only to make movement impossible to miss.
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
    const errorMoved = (base.error ?? null) !== (cur.error ?? null);

    if (!findingsMoved && !errorMoved && rules.length === 0) {
      unchanged++;
      continue;
    }
    deltas.push({
      repo,
      kind: "changed",
      ...(findingsMoved ? { findings: { before: base.findingsCount, after: cur.findingsCount } } : {}),
      ...(errorMoved ? { errorChange: { before: base.error, after: cur.error } } : {}),
      rules,
    });
  }
  return { deltas, unchanged };
}

// --- compose:matrix:baseline (re-bless) -------------------------------------

function main(): void {
  const results = loadResults();
  const count = Object.keys(results).length;
  if (count === 0) {
    console.error("No results/*.json found. Run `pnpm compose:matrix:run` first.");
    process.exit(1);
  }
  writeBaseline(toBaseline(results));
  console.log(`Wrote baseline.json for ${count} repo(s) → ${BASELINE_PATH}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
