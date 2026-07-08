/**
 * harness.ts — the shared skeleton every `experiments/<lang>-matrix` gate is built
 * from: clone a repo at its pinned SHA, distill a scan into a stable per-repo
 * snapshot, diff that snapshot against a committed baseline, and drive the
 * run / check / bless entrypoints.
 *
 * Five near-identical copies of this skeleton lived one per matrix dir — stack
 * (React), shopify (Liquid), unity, android, compose (#247). This is the single
 * source; each dir keeps only its *specifics* and passes them in:
 *   - which scanner to run (in-process aggregator vs a shelled engine vs the CLI),
 *   - which SECONDARY fields it locks alongside the finding stream, and
 *   - the exact key order of its committed baseline record.
 *
 * The HARD invariant this preserves: a dir's committed `baseline.json` is
 * byte-identical before and after the dedup. That is precisely why the per-record
 * `distill` callback — which constructs the snapshot object and therefore fixes its
 * JSON key order, defaults, and rounding — stays DIR-OWNED. The harness sorts repo
 * keys and serializes, but never imposes a record layout; only the dir knows the
 * order its baseline was blessed in.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

// --- clone-at-SHA (identical across every matrix dir) -----------------------

export const slug = (repo: string): string => repo.replace("/", "__");

/** A git runner bound to a clone timeout — the only per-dir knob on the clone path. */
export function makeGit(timeoutMs: number): (args: string[]) => void {
  return (args) => {
    execFileSync("git", args, { stdio: "ignore", timeout: timeoutMs });
  };
}

/** Record the actual HEAD sha of a clone (empty string if not a readable repo). */
export function headSha(dir: string): string {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

/**
 * Park a clone of `repo` at the EXACT pinned `sha` in `dir`: init + fetch-by-sha +
 * checkout (GitHub serves a fetch of a specific reachable sha). If fetch-by-sha is
 * refused (an unadvertised/force-pushed sha), degrade to a shallow branch clone and
 * record whatever HEAD we actually got — the result's `sha`/`pinned` fields make
 * drift visible rather than silent. This freeze is what makes the corpus a
 * regression baseline rather than a moving benchmark.
 */
export function ensureRepoAt(
  git: (args: string[]) => void,
  repo: string,
  sha: string,
  branch: string,
  dir: string,
): void {
  const url = `https://github.com/${repo}.git`;

  if (existsSync(join(dir, ".git"))) {
    if (headSha(dir) === sha) return; // cache already pinned
    try {
      git(["-C", dir, "fetch", "-q", "--depth", "1", "origin", sha]);
      git(["-C", dir, "checkout", "-q", sha]);
    } catch {
      /* keep cached HEAD; result records the actual sha */
    }
    return;
  }

  try {
    mkdirSync(dir, { recursive: true });
    git(["-C", dir, "init", "-q"]);
    git(["-C", dir, "remote", "add", "origin", url]);
    git(["-C", dir, "fetch", "-q", "--depth", "1", "origin", sha]);
    git(["-C", dir, "checkout", "-q", sha]);
  } catch {
    rmSync(dir, { recursive: true, force: true });
    git(["clone", "--depth", "1", "--branch", branch, url, dir]);
  }
}

// --- finding distill (the four finding-stream dirs) -------------------------

/** One scan finding, distilled to the stable, serializable triple we snapshot.
 * `file` is repo-relative so the record is independent of the clone path. */
export interface ResultFinding {
  readonly file: string;
  readonly line: number;
  readonly ruleId: string;
}

export const sortFindings = (a: ResultFinding, b: ResultFinding): number =>
  a.file !== b.file
    ? a.file < b.file
      ? -1
      : 1
    : a.line !== b.line
      ? a.line - b.line
      : a.ruleId < b.ruleId
        ? -1
        : a.ruleId > b.ruleId
          ? 1
          : 0;

/** Re-key an existing ruleId->count map with keys sorted, for a stable serialization. */
export function sortByRuleRecord(byRule: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of Object.keys(byRule).sort()) out[id] = byRule[id];
  return out;
}

/** ruleId -> count with keys sorted, so the serialized object is stable across runs. */
export function byRuleOf(findings: readonly { readonly ruleId: string }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const f of findings) counts[f.ruleId] = (counts[f.ruleId] ?? 0) + 1;
  const sorted: Record<string, number> = {};
  for (const id of Object.keys(counts).sort()) sorted[id] = counts[id];
  return sorted;
}

/**
 * Map raw findings to repo-relative, sorted `ResultFinding`s plus their sorted
 * `byRule` counts and total. The shared primary-layer distill for every
 * finding-stream harness — the sort makes a moved/added/removed finding a
 * line-level, reviewable diff rather than an aggregate count change.
 */
export function distillFindings(
  rawFindings: readonly { readonly file: string; readonly line: number; readonly ruleId: string }[],
  root: string,
): { findingsCount: number; byRule: Record<string, number>; findings: ResultFinding[] } {
  const findings: ResultFinding[] = rawFindings
    .map((f) => ({ file: relative(root, f.file), line: f.line, ruleId: f.ruleId }))
    .sort(sortFindings);
  return { findingsCount: findings.length, byRule: byRuleOf(findings), findings };
}

// --- baseline store (identical everywhere; `distill` is dir-owned) ----------

export interface Store<Raw extends { repo?: string }, Snap> {
  loadResults(): Record<string, Raw>;
  loadBaseline(): Record<string, Snap> | null;
  writeBaseline(b: Record<string, Snap>): void;
  toBaseline(results: Record<string, Raw>): Record<string, Snap>;
}

/**
 * The read/write half of a gate: load raw `results/*.json`, load/write the
 * committed `baseline.json`, and distill raw → snapshot with repo keys sorted.
 * `distill` builds the snapshot object and thus OWNS its key order — the byte
 * layout of `baseline.json` lives with the dir, never here (see file header).
 */
export function makeStore<Raw extends { repo?: string }, Snap>(cfg: {
  resultsDir: string;
  baselinePath: string;
  distill: (r: Raw) => Snap;
}): Store<Raw, Snap> {
  const { resultsDir, baselinePath, distill } = cfg;
  return {
    loadResults() {
      const out: Record<string, Raw> = {};
      if (!existsSync(resultsDir)) return out;
      for (const file of readdirSync(resultsDir)) {
        if (!file.endsWith(".json")) continue;
        const raw = JSON.parse(readFileSync(join(resultsDir, file), "utf8")) as Raw;
        if (raw.repo) out[raw.repo] = raw;
      }
      return out;
    },
    loadBaseline() {
      if (!existsSync(baselinePath)) return null;
      return JSON.parse(readFileSync(baselinePath, "utf8")) as Record<string, Snap>;
    },
    writeBaseline(b) {
      writeFileSync(baselinePath, JSON.stringify(b, null, 2) + "\n");
    },
    toBaseline(results) {
      const out: Record<string, Snap> = {};
      for (const repo of Object.keys(results).sort()) out[repo] = distill(results[repo]);
      return out;
    },
  };
}

// --- diff -------------------------------------------------------------------

export interface RuleDelta {
  readonly ruleId: string;
  readonly before: number;
  readonly after: number;
}

/**
 * One repo whose snapshot moved. `findings` and `errorChange` are the two fields
 * every gate diffs; each dir's own locked numeric fields (files/parseErrors,
 * assets/graph/opaque…, coverage.checked) are spread as TOP-LEVEL keys keyed by
 * the label its `fmtDelta` prints. Only moved fields are present, so a `fmtDelta`
 * (and each dir's committed test) reads `d.<key>` exactly as the pre-dedup per-dir
 * `RepoDelta`/`ThemeDelta` did — read a secondary field via {@link mv}.
 */
export interface SnapshotDelta {
  readonly repo: string;
  readonly kind: "added" | "removed" | "changed";
  readonly findings?: { before: number; after: number };
  readonly errorChange?: { before: string | null; after: string | null };
  readonly rules: readonly RuleDelta[];
  readonly [secondaryKey: string]: unknown;
}

/** Read a secondary movement (`files`/`assets`/`checked`/…) off a delta, typed. */
export function mv(d: SnapshotDelta, key: string): { before: number; after: number } | undefined {
  return d[key] as { before: number; after: number } | undefined;
}

export interface DiffResult {
  readonly deltas: readonly SnapshotDelta[];
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

/** How to read the diffable quantities off a dir's snapshot. */
export interface DiffSpec<Snap> {
  readonly findingsOf: (s: Snap) => number;
  readonly byRuleOf: (s: Snap) => Record<string, number>;
  readonly errorOf: (s: Snap) => string | null;
  /** Ordered secondary numeric fields the gate also locks; `key` is the delta label. */
  readonly secondary: readonly { readonly key: string; readonly get: (s: Snap) => number }[];
}

/**
 * Compare a current snapshot against the committed baseline. Snapshot-equality:
 * ANY movement — findings count, per-rule counts, error transition, or any of the
 * dir's declared SECONDARY fields — is surfaced. The caller decides
 * intended-vs-regression and re-blesses; the gate's job is only to make movement
 * impossible to miss. This reproduces each pre-dedup `diffBaseline` exactly: the
 * unchanged condition is "no findings, no error, no secondary, no rules moved".
 */
export function diffSnapshots<Snap>(
  current: Record<string, Snap>,
  baseline: Record<string, Snap>,
  spec: DiffSpec<Snap>,
): DiffResult {
  const repos = new Set([...Object.keys(baseline), ...Object.keys(current)]);
  const deltas: SnapshotDelta[] = [];
  let unchanged = 0;

  for (const repo of [...repos].sort()) {
    const base = baseline[repo];
    const cur = current[repo];

    if (!base) {
      deltas.push({ repo, kind: "added", findings: { before: 0, after: spec.findingsOf(cur) }, rules: [] });
      continue;
    }
    if (!cur) {
      deltas.push({ repo, kind: "removed", findings: { before: spec.findingsOf(base), after: 0 }, rules: [] });
      continue;
    }

    const rules = ruleDeltas(spec.byRuleOf(base), spec.byRuleOf(cur));
    const findingsMoved = spec.findingsOf(base) !== spec.findingsOf(cur);
    const errorMoved = (spec.errorOf(base) ?? null) !== (spec.errorOf(cur) ?? null);
    // Secondary movements go on the delta as TOP-LEVEL keys, keyed by the field's
    // label, preserving the exact pre-dedup per-dir delta shape (`d.assets`, etc.).
    const moved: Record<string, { before: number; after: number }> = {};
    for (const f of spec.secondary) {
      const b = f.get(base);
      const a = f.get(cur);
      if (b !== a) moved[f.key] = { before: b, after: a };
    }

    if (!findingsMoved && !errorMoved && Object.keys(moved).length === 0 && rules.length === 0) {
      unchanged++;
      continue;
    }
    // Key order mirrors the original: repo, kind, findings?, <secondary>?, errorChange?, rules.
    const delta: Record<string, unknown> = { repo, kind: "changed" };
    if (findingsMoved) delta.findings = { before: spec.findingsOf(base), after: spec.findingsOf(cur) };
    for (const [key, span] of Object.entries(moved)) delta[key] = span;
    if (errorMoved) delta.errorChange = { before: spec.errorOf(base), after: spec.errorOf(cur) };
    delta.rules = rules;
    deltas.push(delta as unknown as SnapshotDelta);
  }
  return { deltas, unchanged };
}

/** `[ruleId +d, …]` — the per-rule delta tail every gate appends. */
export function fmtRules(d: SnapshotDelta): string {
  if (d.rules.length === 0) return "";
  const parts = d.rules.map((r) => {
    const delta = r.after - r.before;
    return `${r.ruleId} ${delta > 0 ? "+" : ""}${delta}`;
  });
  return `  [${parts.join(", ")}]`;
}

// --- run: clone + scan + write one result JSON per repo ---------------------

interface ManifestEntryBase {
  readonly repo: string;
  readonly sha: string;
  readonly defaultBranch: string;
}

/**
 * The shared run loop for a finding-stream gate: read the SHA-pinned manifest,
 * clone each repo at its sha, scan it, and write a stable `results/<slug>.json`.
 * The success record is `{ repo, sha, pinned, error, ...scan }` and the error
 * record is `{ repo, sha, pinned:false, error, ...zero }` — the dir supplies the
 * `scan` callback, its zeroed scan shape, and the per-repo success log line.
 * (stack-matrix drives the CLI out-of-process with a bespoke record, so it keeps
 * its own loop but still uses the clone primitives above.)
 */
export async function runManifest<Entry extends ManifestEntryBase, Scan extends object>(cfg: {
  manifestPath: string;
  manifestKey: string;
  cacheDir: string;
  resultsDir: string;
  cloneTimeoutMs: number;
  errPad: number;
  scan: (dir: string) => Promise<Scan>;
  zero: Scan;
  logSuccess: (repo: string, scan: Scan) => void;
}): Promise<void> {
  if (!existsSync(cfg.manifestPath)) throw new Error(`No manifest at ${cfg.manifestPath}`);
  const manifest = JSON.parse(readFileSync(cfg.manifestPath, "utf8"))[cfg.manifestKey] as Entry[];
  const git = makeGit(cfg.cloneTimeoutMs);

  mkdirSync(cfg.cacheDir, { recursive: true });
  mkdirSync(cfg.resultsDir, { recursive: true });

  for (const entry of manifest) {
    const { repo, sha, defaultBranch } = entry;
    const dir = join(cfg.cacheDir, slug(repo));
    const resultPath = join(cfg.resultsDir, `${slug(repo)}.json`);

    try {
      ensureRepoAt(git, repo, sha, defaultBranch, dir);
      const clonedSha = headSha(dir) || sha;

      const scan = await cfg.scan(dir);
      const result = { repo, sha: clonedSha, pinned: clonedSha === sha, error: null as string | null, ...scan };
      writeFileSync(resultPath, JSON.stringify(result, null, 2) + "\n");

      cfg.logSuccess(repo, scan);
    } catch (err) {
      const msg = (err as Error).message.split("\n")[0];
      const result = { repo, sha, pinned: false, error: msg, ...cfg.zero };
      writeFileSync(resultPath, JSON.stringify(result, null, 2) + "\n");
      console.log(`${repo.padEnd(cfg.errPad)} ERROR: ${msg}`);
    }
  }
}

// --- check: re-scan (optional) + diff + exit-code semantics -----------------

export interface CheckMessages {
  /** printed to STDERR then exit 1 when no baseline.json exists. */
  readonly noBaseline: string;
  /** printed before the re-scan (includes its own trailing newline). */
  readonly rescan: string;
  /** noun in the "N <noun> NOT pinned" warning — "repo(s)" | "theme(s)". */
  readonly pinNoun: string;
  readonly unchanged: (unchanged: number) => string;
  readonly header: (unchanged: number, moved: number) => string;
  readonly footer: (moved: number) => string;
}

/**
 * The gate driver: load the baseline, optionally re-scan (`--no-run` skips it),
 * warn on any repo that fell off its pinned sha, diff, and exit — 0 on no drift,
 * 1 on any movement. The exit-code contract is the gate; message wording is
 * per-dir and passed in so the console output stays byte-identical to the
 * pre-dedup gates.
 */
export async function runCheck<Raw extends { repo?: string; pinned?: boolean; error?: string | null }, Snap>(cfg: {
  argv: readonly string[];
  runAll: () => void | Promise<void>;
  store: Store<Raw, Snap>;
  diff: (current: Record<string, Snap>, baseline: Record<string, Snap>) => DiffResult;
  fmtDelta: (d: SnapshotDelta) => string;
  messages: CheckMessages;
}): Promise<void> {
  const skipRun = cfg.argv.includes("--no-run");

  const baseline = cfg.store.loadBaseline();
  if (baseline === null) {
    console.error(cfg.messages.noBaseline);
    process.exit(1);
  }

  if (!skipRun) {
    console.log(cfg.messages.rescan);
    await cfg.runAll();
    console.log("");
  }

  const raw = cfg.store.loadResults();

  // Pin integrity: a repo that fell back to a floating branch clone (fetch-by-sha
  // refused) is no longer frozen at its manifest sha — its delta may be upstream
  // drift, not your change. Surface it; do not let it pass silently as a code
  // regression.
  const unpinned = Object.values(raw)
    .filter((r) => r.pinned === false && !r.error)
    .map((r) => r.repo);
  if (unpinned.length > 0) {
    console.log(
      `⚠ ${unpinned.length} ${cfg.messages.pinNoun} NOT pinned to manifest sha — their deltas may reflect ` +
        `upstream drift, not your change: ${unpinned.join(", ")}\n`,
    );
  }

  const current = cfg.store.toBaseline(raw);
  const { deltas, unchanged } = cfg.diff(current, baseline);

  if (deltas.length === 0) {
    console.log(cfg.messages.unchanged(unchanged));
    process.exit(0);
  }

  console.log(cfg.messages.header(unchanged, deltas.length));
  for (const d of deltas) console.log(cfg.fmtDelta(d));
  console.log(cfg.messages.footer(deltas.length));
  process.exit(1);
}

// --- bless: overwrite baseline.json from results/ ---------------------------

export interface BlessMessages {
  readonly empty: string;
  readonly wrote: (count: number, baselinePath: string) => string;
}

/** Re-bless: read `results/`, distill, overwrite `baseline.json` (repo keys sorted). */
export function runBless<Raw extends { repo?: string }, Snap>(cfg: {
  store: Store<Raw, Snap>;
  baselinePath: string;
  messages: BlessMessages;
}): void {
  const results = cfg.store.loadResults();
  const count = Object.keys(results).length;
  if (count === 0) {
    console.error(cfg.messages.empty);
    process.exit(1);
  }
  cfg.store.writeBaseline(cfg.store.toBaseline(results));
  console.log(cfg.messages.wrote(count, cfg.baselinePath));
}
