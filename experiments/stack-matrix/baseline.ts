/**
 * baseline.ts — the real-world regression baseline: a committed snapshot of the
 * checker's results across the pinned repo corpus, plus the diff that turns the
 * benchmark into a regression gate.
 *
 * The corpus (manifest.json) is SHA-pinned, so the only thing that can move
 * these numbers is the checker's own code. We distill each per-repo result into
 * a compact, deterministic record and commit it as `baseline.json`. Every change
 * that shifts real-world behavior must show up as an edit to that file in the
 * PR — silent drift becomes a visible diff in review. That is the anti-rot
 * mechanism; there is no robot, just evidence committed next to the code.
 *
 *   matrix:baseline   re-bless: read results/ → write baseline.json (sorted)
 *   matrix:check      re-scan + diff current vs baseline (see check.ts)
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

/** repo -> snapshot. Serialized with keys sorted so git diffs are readable. */
export type Baseline = Record<string, RepoBaseline>;

const ZERO_COVERAGE = { checked: 0, trusted: 0, declare: 0, icons: 0, structural: 0, total: 0 };

/** Read every results/*.json into a repo-keyed map of raw results. */
export function loadResults(): Record<string, RawResult> {
  const out: Record<string, RawResult> = {};
  if (!existsSync(RESULTS_DIR)) return out;
  for (const file of readdirSync(RESULTS_DIR)) {
    if (!file.endsWith(".json")) continue;
    const raw = JSON.parse(readFileSync(join(RESULTS_DIR, file), "utf8")) as RawResult;
    if (raw.repo) out[raw.repo] = raw;
  }
  return out;
}

function countByRule(findings: readonly Finding[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const f of findings) counts[f.ruleId] = (counts[f.ruleId] ?? 0) + 1;
  // Sort keys so the serialized object is stable across runs.
  const sorted: Record<string, number> = {};
  for (const key of Object.keys(counts).sort()) sorted[key] = counts[key];
  return sorted;
}

/** Distill one raw result into its committed snapshot form. */
export function toRepoBaseline(r: RawResult): RepoBaseline {
  return {
    sha: r.sha ?? "",
    findings: r.summary?.findings ?? 0,
    blocking: r.summary?.blocking ?? 0,
    warning: r.summary?.warning ?? 0,
    coverage: r.coverage ?? { ...ZERO_COVERAGE },
    byRule: countByRule(r.findings ?? []),
    error: r.error ?? null,
  };
}

/** Build a full baseline from a raw-results map, keys sorted for stable output. */
export function toBaseline(results: Record<string, RawResult>): Baseline {
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
  readonly checked?: { before: number; after: number };
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
 * ANY movement (findings, coverage.checked, error transition, per-rule counts)
 * is surfaced. The caller decides intended-vs-regression and re-blesses; the
 * gate's job is only to make movement impossible to miss.
 */
export function diffBaseline(current: Baseline, baseline: Baseline): DiffResult {
  const repos = new Set([...Object.keys(baseline), ...Object.keys(current)]);
  const deltas: RepoDelta[] = [];
  let unchanged = 0;

  for (const repo of [...repos].sort()) {
    const base = baseline[repo];
    const cur = current[repo];

    if (!base) {
      deltas.push({ repo, kind: "added", findings: { before: 0, after: cur.findings }, rules: [] });
      continue;
    }
    if (!cur) {
      deltas.push({ repo, kind: "removed", findings: { before: base.findings, after: 0 }, rules: [] });
      continue;
    }

    const rules = ruleDeltas(base.byRule, cur.byRule);
    const findingsMoved = base.findings !== cur.findings;
    const checkedMoved = base.coverage.checked !== cur.coverage.checked;
    const errorMoved = (base.error ?? null) !== (cur.error ?? null);

    if (!findingsMoved && !checkedMoved && !errorMoved && rules.length === 0) {
      unchanged++;
      continue;
    }
    deltas.push({
      repo,
      kind: "changed",
      ...(findingsMoved ? { findings: { before: base.findings, after: cur.findings } } : {}),
      ...(checkedMoved ? { checked: { before: base.coverage.checked, after: cur.coverage.checked } } : {}),
      ...(errorMoved ? { errorChange: { before: base.error, after: cur.error } } : {}),
      rules,
    });
  }
  return { deltas, unchanged };
}

// --- matrix:baseline (re-bless) ---------------------------------------------

function main() {
  const results = loadResults();
  const count = Object.keys(results).length;
  if (count === 0) {
    console.error("No results/*.json found. Run `pnpm matrix:run` first.");
    process.exit(1);
  }
  writeBaseline(toBaseline(results));
  console.log(`Wrote baseline.json for ${count} repos → ${BASELINE_PATH}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
