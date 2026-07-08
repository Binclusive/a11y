/**
 * De-duplicating reconciler for inline PR review comments (issue #2131).
 *
 * The CI Action posts one inline review comment per a11y finding. Without a
 * stable identity, every push re-POSTs every finding — spamming the PR thread
 * with a fresh copy of the same comment on each run. This module gives each
 * finding a stable hidden MARKER and reconciles the desired findings against the
 * comments already on the PR, so a re-run converges to exactly one comment per
 * finding instead of accumulating duplicates:
 *
 *   - a finding already commented → UPDATE its comment in place (or leave it
 *     untouched when the body is identical) — never a second POST,
 *   - a brand-new finding         → CREATE one comment,
 *   - a finding that was fixed     → DELETE its now-orphaned comment.
 *
 * The marker is an HTML comment (`<!-- binclusive-a11y-agent:<key> -->`) so it
 * is invisible in the rendered comment yet machine-findable. Reconciliation only
 * ever touches comments carrying that marker, so human review comments are never
 * matched, updated, or removed.
 *
 * Contract-independent and side-effect-free at its core: {@link reconcile} is a
 * pure function of (desired findings, existing comments); the effectful GitHub
 * calls are injected through {@link PrCommentClient} so the reconcile logic is
 * testable against an in-memory fake.
 */

// The canonical finding shape a reporter renders from now lives in the seam
// (`reporter/finding.ts`), so the platform-neutral input type is not owned by
// this GitHub-specific surface. Re-exported here for existing importers.
import { type Finding, type Impact, parseFindings } from "./reporter/finding";
export { type Finding, type Impact, parseFindings };

/** An existing inline review comment already on the PR (id + rendered body). */
export interface ReviewComment {
  readonly id: number;
  readonly body: string;
  /**
   * The comment author's login (GitHub `user.login`), when the platform supplies
   * it. Feeds the {@link reconcile} author guard: our marker is public text anyone
   * could paste, so a marker on a comment authored by someone other than us is not
   * actually ours. Absent ⇒ the guard falls back to marker-only matching.
   */
  readonly author?: string;
}

const MARKER_TAG = "binclusive-a11y-agent";
// Composed from MARKER_TAG so the tag lives in exactly one place — the marker we
// WRITE (markerFor) and the marker we READ (keyOf) can never drift apart. Safe to
// interpolate raw: MARKER_TAG is a fixed [a-z-] literal with no regex metachars.
const MARKER_RE = new RegExp(`<!--\\s*${MARKER_TAG}:(.*?)\\s*-->`);

/**
 * A live rendered element locator. Mirrors `emit-contract.ts`'s `hasSelector`:
 * empty / whitespace-only is NOT a selector (a source pass has no DOM node), so
 * it does not disambiguate and the base `ruleId:file:line` identity stands.
 * Kept local so this CI-comment surface doesn't drag in the contract package.
 */
function hasSelector(selector: string | undefined): selector is string {
  return selector !== undefined && selector.trim() !== "";
}

/**
 * FNV-1a → 8 hex chars. The selector is folded into the marker, and a raw CSS
 * selector can carry spaces, `>>>`, `-->`, or newlines — any of which would
 * break the single-line HTML-comment marker (a `-->` closes it early; a newline
 * makes {@link keyOf} fail to match, so the comment reads as not-ours and gets
 * re-posted every push). Hashing into a fixed `[0-9a-f]` token is marker-safe by
 * construction; we never decode it back — it exists only to make distinct
 * selectors produce distinct keys.
 */
function selectorToken(selector: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < selector.length; i++) {
    h ^= selector.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * The stable identity of a finding across pushes. Base identity is rule +
 * location (`ruleId:file:line`); when the finding carries a live DOM selector
 * it is folded in (as a marker-safe hash) so two same-rule findings co-located
 * at one `file:line` — distinguished ONLY by their selector — get DISTINCT keys
 * instead of the second silently collapsing onto the first (the #2131 review's
 * blocking defect). This mirrors the engine's own `element = selector ?? ruleId`
 * disambiguation (`emit-contract.ts`). A source finding with no selector keeps
 * the bare `ruleId:file:line` key it always had.
 *
 * Deliberately EXCLUDES the message — when only the wording changes for the same
 * rule/spot/element we update the existing comment in place, not orphan it and
 * post a new one. A finding that genuinely moved to a different line (or a
 * different element) is a different anchor and reconciles as delete-old +
 * create-new.
 */
export function findingKey(f: Finding): string {
  const base = `${f.ruleId}:${f.file}:${f.line}`;
  return hasSelector(f.selector) ? `${base}:${selectorToken(f.selector)}` : base;
}

/** The hidden marker embedded in every agent-authored comment for `f`. */
export function markerFor(f: Finding): string {
  return `<!-- ${MARKER_TAG}:${findingKey(f)} -->`;
}

/**
 * The finding key carried by a comment, or `null` if the comment is not one of
 * ours (no marker) — the sole gate that keeps reconciliation off human comments.
 */
export function keyOf(body: string): string | null {
  const m = MARKER_RE.exec(body);
  // An empty/whitespace-only key (`<!-- ...agent: -->`) identifies no finding, so
  // it can't be reconciled against one — treat it as not-ours rather than let a
  // degenerate "" key collide in the reconcile maps.
  if (!m || m[1] === undefined || m[1] === "") return null;
  return m[1];
}

/** Render the full comment body for `f`, marker appended so it round-trips. */
export function renderBody(f: Finding): string {
  const wcag = (f.wcag ?? []).map((s) => `WCAG ${s}`).join(", ") || "no WCAG mapping";
  return `**a11y: \`${f.ruleId}\`** (${wcag})\n\n${f.message}\n\n${markerFor(f)}`;
}

/**
 * The outcome of a single inline-comment CREATE. GitHub rejects an inline comment
 * whose line is not part of the PR diff hunk with a 422
 * (`pull_request_review_thread.line ... could not be resolved`) — that rejection is
 * NOT a failure to swallow as a phantom "created": it means the finding cannot be
 * anchored inline and must fall back to the summary surface (#207). A `create`
 * therefore reports which surface the finding landed on rather than returning void:
 *   - "created"           — posted inline, exactly as an in-hunk finding always has,
 *   - "line-outside-diff" — a 422: the line is outside the diff hunk, so no inline
 *                           anchor exists; the finding is NOT posted, it falls back,
 *   - "failed"            — any other error (auth, network, 5xx); logged, non-fatal.
 */
export type CreateOutcome = "created" | "line-outside-diff" | "failed";

/** The reconciliation plan: what to do to converge the PR to `findings`. */
export interface ReconcilePlan {
  /** Findings with no existing comment — POST a new one. */
  readonly create: readonly Finding[];
  /** Findings whose comment exists but whose body drifted — PATCH in place. */
  readonly update: readonly { readonly id: number; readonly finding: Finding }[];
  /** Comment ids to DELETE: a fixed finding, or a leftover duplicate. */
  readonly remove: readonly number[];
  /** Comment ids left untouched (body already identical) — no API call. */
  readonly unchanged: readonly number[];
  /**
   * Findings GitHub refused to inline because their line falls OUTSIDE the PR diff
   * hunk (a 422 on create — see {@link CreateOutcome}). Collected, never swallowed
   * as a phantom "created", so the caller knows they reached only the fallback
   * (summary) surface and no finding vanishes silently (#207). Empty at plan time —
   * a pure {@link reconcile} has executed nothing yet; populated by {@link syncComments}.
   */
  readonly notInlined: readonly Finding[];
}

/**
 * Pure reconciliation: given the findings a run wants on the PR and the comments
 * already there, decide the minimal set of create / update / delete operations
 * that converges the PR to exactly one comment per finding. Idempotent — running
 * it twice with the same inputs yields an all-`unchanged` plan (no churn).
 *
 * Only marker-carrying comments (ours) are considered; everything else is left
 * alone. A pre-dedup PR may hold several comments for one key (the old spamming
 * behavior); the canonical one (first seen) is kept/updated and the rest are
 * folded into `remove`, so the very first reconciling run also cleans up.
 *
 * `self` is the login we post under: when given, a marker comment authored by a
 * DIFFERENT login is not treated as ours (someone pasted our marker) — we never
 * update or delete it. Omitted, or a comment with no known author, keeps the
 * marker-only behavior, so passing an unknown `self` can never make us skip our
 * own comments and re-post duplicates.
 */
export function reconcile(
  findings: readonly Finding[],
  existing: readonly ReviewComment[],
  self?: string,
): ReconcilePlan {
  // Desired findings keyed by identity; first occurrence wins on collision.
  const desired = new Map<string, Finding>();
  for (const f of findings) {
    const k = findingKey(f);
    if (!desired.has(k)) desired.set(k, f);
  }

  // Our existing comments keyed by their marker. A key seen more than once is a
  // leftover duplicate from before dedup existed — keep the first, delete the rest.
  const ours = new Map<string, ReviewComment>();
  const remove: number[] = [];
  for (const c of existing) {
    const k = keyOf(c.body);
    if (k === null) continue; // no marker — never touch human comments
    // Author guard: a marker on a comment someone else authored is not ours.
    if (self !== undefined && c.author !== undefined && c.author !== self) continue;
    if (ours.has(k)) remove.push(c.id);
    else ours.set(k, c);
  }

  const create: Finding[] = [];
  const update: { id: number; finding: Finding }[] = [];
  const unchanged: number[] = [];

  for (const [k, f] of desired) {
    const c = ours.get(k);
    if (!c) create.push(f);
    else if (c.body === renderBody(f)) unchanged.push(c.id);
    else update.push({ id: c.id, finding: f });
  }

  // Any of our comments whose finding is no longer present was fixed → remove it.
  for (const [k, c] of ours) {
    if (!desired.has(k)) remove.push(c.id);
  }

  return { create, update, remove, unchanged, notInlined: [] };
}

/**
 * The effectful surface reconciliation drives, injected so the orchestration is
 * testable against an in-memory fake. Every method is best-effort: an
 * implementation logs and swallows failures rather than throwing, so a single
 * bad call never aborts the rest of the sync (the Action stays advisory).
 */
export interface PrCommentClient {
  /**
   * All inline review comments currently on the PR (paginated upstream). MUST
   * resolve to a COMPLETE view or THROW — never a partial list. If any page
   * fetch fails, reconciling against the truncated result would read an existing
   * comment (on an unfetched page) as absent and re-CREATE it → a duplicate. So
   * a page failure aborts the whole sync (via {@link syncCommentsBestEffort},
   * which swallows the throw and skips the run) rather than half-reconciling.
   */
  list(): Promise<ReviewComment[]>;
  /**
   * POST a new inline review comment for `f`, reporting which surface it reached
   * ({@link CreateOutcome}). A GitHub 422 for a line outside the diff hunk MUST come
   * back as `"line-outside-diff"`, never a swallowed void that {@link syncComments}
   * then mislogs as a success (#207) — that phantom success is the exact bug this
   * contract widening fixes.
   */
  create(f: Finding): Promise<CreateOutcome>;
  /** PATCH the body of comment `id` to match `f`. */
  update(id: number, f: Finding): Promise<void>;
  /** DELETE comment `id` (its finding was fixed, or it is a leftover duplicate). */
  remove(id: number): Promise<void>;
}

/**
 * Reconcile the PR's inline comments to `findings` through `client`, returning
 * the plan that was executed (handy for logging and assertions). Updates in
 * place and removes fixed findings instead of ever posting a duplicate.
 */
export async function syncComments(
  findings: readonly Finding[],
  client: PrCommentClient,
  log: (msg: string) => void = () => {},
  self?: string,
): Promise<ReconcilePlan> {
  const existing = await client.list();
  const plan = reconcile(findings, existing, self);

  // Findings GitHub could not anchor inline (line outside the diff hunk). We do NOT
  // log these as "created" — that phantom success is the #207 bug — but fall back:
  // they stay on the summary surface, which lists every finding regardless of diff
  // position, so the finding is surfaced rather than silently dropped from the PR.
  const notInlined: Finding[] = [];
  for (const f of plan.create) {
    const outcome = await client.create(f);
    if (outcome === "created") {
      log(`created comment for ${findingKey(f)}`);
    } else if (outcome === "line-outside-diff") {
      notInlined.push(f);
      log(`could not inline ${findingKey(f)} (line outside the diff hunk) — falling back to the summary surface`);
    } else {
      log(`failed to post inline comment for ${findingKey(f)} (see the error above)`);
    }
  }
  for (const { id, finding } of plan.update) {
    await client.update(id, finding);
    log(`updated comment ${id} for ${findingKey(finding)}`);
  }
  for (const id of plan.remove) {
    await client.remove(id);
    log(`removed comment ${id} (finding fixed or duplicate)`);
  }
  log(
    `sync: ${plan.create.length - notInlined.length} created, ${plan.update.length} updated, ` +
      `${plan.remove.length} removed, ${plan.unchanged.length} unchanged, ${notInlined.length} not inlined (line outside diff)`,
  );
  return { ...plan, notInlined };
}

/**
 * The best-effort boundary the CI entrypoint runs: {@link syncComments} wrapped
 * so it NEVER throws. Comment de-duplication is advisory — a failure (a
 * partial-list abort, a mid-sync API error, a bad JSON parse) must log and skip
 * the run, never fail the CI job. Returns the executed plan, or `null` when the
 * sync was aborted/skipped. This is the invariant the top-level CLI relies on to
 * always exit 0.
 */
export async function syncCommentsBestEffort(
  findings: readonly Finding[],
  client: PrCommentClient,
  log: (msg: string) => void = () => {},
  self?: string,
): Promise<ReconcilePlan | null> {
  try {
    return await syncComments(findings, client, log, self);
  } catch (e) {
    log(`sync aborted (best-effort, no-op): ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
