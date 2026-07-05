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

/** The subset of an a11y finding an inline PR comment is rendered from. */
export interface Finding {
  readonly ruleId: string;
  readonly file: string;
  readonly line: number;
  readonly message: string;
  readonly wcag?: readonly string[];
}

/** An existing inline review comment already on the PR (id + rendered body). */
export interface ReviewComment {
  readonly id: number;
  readonly body: string;
}

const MARKER_TAG = "binclusive-a11y-agent";
const MARKER_RE = /<!--\s*binclusive-a11y-agent:(.*?)\s*-->/;

/**
 * The stable identity of a finding across pushes: rule + location. Deliberately
 * EXCLUDES the message — when only the wording changes for the same rule at the
 * same spot we want to update the existing comment in place, not orphan it and
 * post a new one. A finding that genuinely moved to a different line is a
 * different anchor and correctly reconciles as delete-old + create-new.
 */
export function findingKey(f: Finding): string {
  return `${f.ruleId}:${f.file}:${f.line}`;
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
  return m && m[1] !== undefined ? m[1] : null;
}

/** Render the full comment body for `f`, marker appended so it round-trips. */
export function renderBody(f: Finding): string {
  const wcag = (f.wcag ?? []).map((s) => `WCAG ${s}`).join(", ") || "no WCAG mapping";
  return `**a11y: \`${f.ruleId}\`** (${wcag})\n\n${f.message}\n\n${markerFor(f)}`;
}

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
 */
export function reconcile(
  findings: readonly Finding[],
  existing: readonly ReviewComment[],
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
    if (k === null) continue; // not ours — never touch human comments
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

  return { create, update, remove, unchanged };
}

/**
 * The effectful surface reconciliation drives, injected so the orchestration is
 * testable against an in-memory fake. Every method is best-effort: an
 * implementation logs and swallows failures rather than throwing, so a single
 * bad call never aborts the rest of the sync (the Action stays advisory).
 */
export interface PrCommentClient {
  /** All inline review comments currently on the PR (paginated upstream). */
  list(): Promise<ReviewComment[]>;
  /** POST a new inline review comment for `f`. */
  create(f: Finding): Promise<void>;
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
): Promise<ReconcilePlan> {
  const existing = await client.list();
  const plan = reconcile(findings, existing);

  for (const f of plan.create) {
    await client.create(f);
    log(`created comment for ${findingKey(f)}`);
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
    `sync: ${plan.create.length} created, ${plan.update.length} updated, ` +
      `${plan.remove.length} removed, ${plan.unchanged.length} unchanged`,
  );
  return plan;
}

/**
 * Boundary parse of the engine's findings JSON into the minimal shape this
 * module renders from. Unknown in, narrowed out — a malformed entry is dropped
 * rather than smuggling `any` inward (same discipline as the rest of the engine).
 */
export function parseFindings(raw: unknown): Finding[] {
  if (typeof raw !== "object" || raw === null) return [];
  const findings = (raw as { findings?: unknown }).findings;
  if (!Array.isArray(findings)) return [];
  const out: Finding[] = [];
  for (const item of findings) {
    if (typeof item !== "object" || item === null) continue;
    const f = item as Record<string, unknown>;
    if (typeof f.ruleId !== "string" || typeof f.file !== "string") continue;
    if (typeof f.line !== "number") continue;
    const wcag = Array.isArray(f.wcag) ? f.wcag.filter((w): w is string => typeof w === "string") : undefined;
    out.push({
      ruleId: f.ruleId,
      file: f.file,
      line: f.line,
      message: typeof f.message === "string" ? f.message : "",
      ...(wcag ? { wcag } : {}),
    });
  }
  return out;
}
