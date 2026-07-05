/**
 * The consolidated PR summary / rollup (issue #2132).
 *
 * The inline reconciler ({@link ./pr-comment}) posts one comment per finding, on
 * the offending line. A reviewer still has no single place to see the SHAPE of a
 * run — how many findings, how bad, which WCAG criteria. This module renders that
 * rollup and posts it two ways:
 *
 *   - a **GitHub Actions job summary** ($GITHUB_STEP_SUMMARY), visible on the run
 *     page even with NO PR context (push to a branch, manual dispatch), and
 *   - **one rollup PR comment**, updated in place across pushes.
 *
 * The counts derive ONLY from the `@binclusive/a11y-contract` metadata the report
 * already carries — `severity` (`critical`/`major`/`minor`) and `criterion` (the
 * WCAG SC id). No source snippet is manufactured (ADR 0039); the file/line links
 * are the same local navigation aid the inline comments already render.
 *
 * Dedup discipline, one level up from #2131: there is exactly ONE rollup comment,
 * found by a stable hidden marker and UPDATED IN PLACE on every push — never a
 * fresh rollup appended per run. The counts reflect the reconciled set: they are
 * computed over the findings deduped by {@link findingKey}, the same identity the
 * inline reconciler uses, and a fixed finding is simply absent from the report so
 * it drops out of the rollup for free.
 *
 * Pure at its core: {@link computeRollup} and the renderers are side-effect-free
 * functions of their inputs; the effectful GitHub calls are injected through
 * {@link RollupClient} so the reconcile logic is testable against a fake.
 */
import { type Finding, findingKey, type Severity } from "./pr-comment";

/** Severity buckets in report order — the contract's 3-level enum. */
export const SEVERITY_ORDER = ["critical", "major", "minor"] as const;

/** The rollup shape a run wants to render: total + by-severity + by-WCAG-criterion. */
export interface Rollup {
  /** Total findings in the reconciled set (deduped by {@link findingKey}). */
  readonly total: number;
  /** Count per contract severity, always carrying all three buckets. */
  readonly bySeverity: Record<Severity, number>;
  /** Findings with no contract severity (an older report, or an unmapped rule). */
  readonly unknownSeverity: number;
  /** Count per WCAG criterion, descending by count then criterion id. */
  readonly byCriterion: readonly { readonly criterion: string; readonly count: number }[];
}

/** The marker used to render a criterion with no SC mapping. */
const NO_CRITERION = "(no WCAG mapping)";

/**
 * Compute the rollup over `findings`, deduped by {@link findingKey} (first
 * occurrence wins) so two comments that would collapse to one inline comment also
 * count once — the rollup total equals the number of inline comments a converged
 * PR carries. Fixed findings are already absent from the report, so they never
 * reach here: the rollup reflects the reconciled set by construction.
 */
export function computeRollup(findings: readonly Finding[]): Rollup {
  const deduped = new Map<string, Finding>();
  for (const f of findings) {
    const k = findingKey(f);
    if (!deduped.has(k)) deduped.set(k, f);
  }

  const bySeverity: Record<Severity, number> = { critical: 0, major: 0, minor: 0 };
  let unknownSeverity = 0;
  const criterionCounts = new Map<string, number>();

  for (const f of deduped.values()) {
    if (f.severity !== undefined) bySeverity[f.severity] += 1;
    else unknownSeverity += 1;
    const criterion = f.criterion !== undefined && f.criterion !== "" ? f.criterion : NO_CRITERION;
    criterionCounts.set(criterion, (criterionCounts.get(criterion) ?? 0) + 1);
  }

  const byCriterion = [...criterionCounts.entries()]
    .map(([criterion, count]) => ({ criterion, count }))
    .sort((a, b) => b.count - a.count || a.criterion.localeCompare(b.criterion));

  return { total: deduped.size, bySeverity, unknownSeverity, byCriterion };
}

/** Options that inject the (env-derived) file link into the otherwise-pure renderers. */
export interface RenderOptions {
  /** Resolve a finding to a clickable link to its changed file / line, or `undefined` for plain text. */
  readonly linkFor?: (finding: Finding) => string | undefined;
  /** How many per-finding rows to list before collapsing into an "and N more" line. */
  readonly maxRows?: number;
}

const DEFAULT_MAX_ROWS = 50;

function severityLine(rollup: Rollup): string {
  const parts = SEVERITY_ORDER.map((s) => `${rollup.bySeverity[s]} ${s}`);
  if (rollup.unknownSeverity > 0) parts.push(`${rollup.unknownSeverity} unclassified`);
  return parts.join(" · ");
}

/** The shared markdown body of the rollup, minus any marker. */
function renderBody(rollup: Rollup, findings: readonly Finding[], opts: RenderOptions): string {
  if (rollup.total === 0) {
    return "## ♿ Accessibility summary\n\nNo accessibility findings in the scanned changes. ✅";
  }

  const lines: string[] = [];
  lines.push("## ♿ Accessibility summary");
  lines.push("");
  lines.push(`**${rollup.total}** finding${rollup.total === 1 ? "" : "s"} — ${severityLine(rollup)}`);

  lines.push("");
  lines.push("| Severity | Count |");
  lines.push("| --- | ---: |");
  for (const s of SEVERITY_ORDER) lines.push(`| ${s} | ${rollup.bySeverity[s]} |`);
  if (rollup.unknownSeverity > 0) lines.push(`| unclassified | ${rollup.unknownSeverity} |`);

  lines.push("");
  lines.push("| WCAG criterion | Count |");
  lines.push("| --- | ---: |");
  for (const { criterion, count } of rollup.byCriterion) lines.push(`| ${criterion} | ${count} |`);

  // Per-finding list linking back to the changed files / inline comments. The
  // file/line come from the local report (the same source the inline comments
  // anchor on) — a navigation aid, not a wire-crossing source snippet.
  const maxRows = opts.maxRows ?? DEFAULT_MAX_ROWS;
  const seen = new Set<string>();
  const rows: string[] = [];
  for (const f of findings) {
    const k = findingKey(f);
    if (seen.has(k)) continue;
    seen.add(k);
    const link = opts.linkFor?.(f);
    const where = `${f.file}:${f.line}`;
    const loc = link ? `[${where}](${link})` : `\`${where}\``;
    rows.push(`- ${loc} — \`${f.ruleId}\`${f.criterion ? ` (WCAG ${f.criterion})` : ""}`);
  }
  if (rows.length > 0) {
    lines.push("");
    lines.push("### Findings");
    lines.push(...rows.slice(0, maxRows));
    if (rows.length > maxRows) lines.push(`- …and ${rows.length - maxRows} more`);
  }

  return lines.join("\n");
}

/** Render the GitHub Actions job summary markdown (no marker — it is not reconciled). */
export function renderJobSummary(
  rollup: Rollup,
  findings: readonly Finding[],
  opts: RenderOptions = {},
): string {
  return renderBody(rollup, findings, opts);
}

/**
 * The stable hidden marker that identifies THE rollup comment. Unlike the inline
 * markers there is exactly one (no per-finding key) — its whole job is to let a
 * later push find the single existing rollup and update it in place.
 */
export const ROLLUP_MARKER = "<!-- binclusive-a11y-rollup -->";

/** True iff `body` is our rollup comment (carries the marker) — the gate that keeps reconciliation off other comments. */
export function isRollupComment(body: string): boolean {
  return body.includes(ROLLUP_MARKER);
}

/** Render the rollup PR comment body, marker appended so a later push can find it. */
export function renderRollupComment(
  rollup: Rollup,
  findings: readonly Finding[],
  opts: RenderOptions = {},
): string {
  return `${renderBody(rollup, findings, opts)}\n\n${ROLLUP_MARKER}`;
}

/** A conversation comment already on the PR (id + rendered body). */
export interface RollupComment {
  readonly id: number;
  readonly body: string;
}

/** The plan to converge the PR to exactly one rollup comment. */
export interface RollupPlan {
  /** Post a new rollup comment — no existing one was found. */
  readonly create: boolean;
  /** PATCH this comment's body (the canonical rollup exists but drifted). */
  readonly update: number | null;
  /** The canonical rollup is already correct — leave it (no API call). */
  readonly unchanged: number | null;
  /** Extra rollup comments to DELETE (leftover double-posts from before dedup). */
  readonly remove: readonly number[];
}

/**
 * Pure reconciliation: given the desired rollup body and the comments already on
 * the PR, decide the single create/update/unchanged plus any duplicate rollups to
 * clean up. Only marker-carrying comments are ours; the first is canonical, the
 * rest are folded into `remove` so a PR that accumulated rollups before this
 * dedup existed converges to one. Idempotent — a second run with the same inputs
 * yields an `unchanged` plan with no churn.
 */
export function reconcileRollup(desiredBody: string, existing: readonly RollupComment[]): RollupPlan {
  const ours = existing.filter((c) => isRollupComment(c.body));
  if (ours.length === 0) {
    return { create: true, update: null, unchanged: null, remove: [] };
  }
  const [canonical, ...dupes] = ours;
  // canonical is defined: ours.length > 0 guarantees a first element.
  const keep = canonical as RollupComment;
  const remove = dupes.map((c) => c.id);
  if (keep.body === desiredBody) {
    return { create: false, update: null, unchanged: keep.id, remove };
  }
  return { create: false, update: keep.id, unchanged: null, remove };
}

/**
 * The effectful surface the rollup reconciliation drives, injected so the
 * orchestration is testable against an in-memory fake. Every method is
 * best-effort in its implementation — a failure is logged and swallowed so the
 * Action stays advisory.
 */
export interface RollupClient {
  /**
   * All conversation comments on the PR. MUST resolve to a COMPLETE view or
   * THROW — never a partial list: reconciling against a truncated view could
   * read the existing rollup (on an unfetched page) as absent and re-CREATE it,
   * the exact double-post this module exists to prevent.
   */
  list(): Promise<RollupComment[]>;
  /** POST the one rollup comment. */
  create(body: string): Promise<void>;
  /** PATCH the rollup comment `id` to `body`. */
  update(id: number, body: string): Promise<void>;
  /** DELETE a leftover duplicate rollup `id`. */
  remove(id: number): Promise<void>;
}

/**
 * Reconcile the PR's rollup comment to `findings` through `client`, returning the
 * executed plan. Updates the one rollup in place, cleans up any duplicates, and
 * posts only when none exists — never a second rollup per push.
 */
export async function syncRollup(
  findings: readonly Finding[],
  client: RollupClient,
  opts: RenderOptions = {},
  log: (msg: string) => void = () => {},
): Promise<RollupPlan> {
  const rollup = computeRollup(findings);
  const desiredBody = renderRollupComment(rollup, findings, opts);
  const existing = await client.list();
  const plan = reconcileRollup(desiredBody, existing);

  if (plan.create) {
    await client.create(desiredBody);
    log("created rollup comment");
  } else if (plan.update !== null) {
    await client.update(plan.update, desiredBody);
    log(`updated rollup comment ${plan.update}`);
  } else {
    log(`rollup comment ${plan.unchanged} unchanged`);
  }
  for (const id of plan.remove) {
    await client.remove(id);
    log(`removed duplicate rollup comment ${id}`);
  }
  return plan;
}

/**
 * The best-effort boundary the CI entrypoint runs: {@link syncRollup} wrapped so
 * it NEVER throws. The rollup is advisory — any render/list/post failure must log
 * and skip, never fail the CI job. Returns the executed plan, or `null` when the
 * sync was aborted/skipped.
 */
export async function syncRollupBestEffort(
  findings: readonly Finding[],
  client: RollupClient,
  opts: RenderOptions = {},
  log: (msg: string) => void = () => {},
): Promise<RollupPlan | null> {
  try {
    return await syncRollup(findings, client, opts, log);
  } catch (e) {
    log(`rollup sync aborted (best-effort, no-op): ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
