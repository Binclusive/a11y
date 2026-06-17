import { type CorpusPattern, corpusJourneyTags, corpusPatterns } from "./corpus";
import type { Finding } from "./core";
import type { ComponentResolution } from "./resolve-components";

/**
 * The pure, in-context corpus-slice retriever — RFC Phase 1 (1c). NO vectors:
 * over ~100 distilled patterns a closed-vocabulary token-overlap union is exact
 * and deterministic, so the slice that grounds the agent is reproducible and
 * unit-testable WITHOUT a model.
 *
 * The slice is the union of three retrievers, deduped by pattern id, capped at
 * {@link SLICE_CAP} ordered by frequency tier:
 *
 *   - R1 by resolved component (dominant) — a pattern whose `component` label
 *     token-overlaps a resolved component's `name`/`host`, INCLUDING opaque and
 *     trusted resolutions (the long tail the static floor can't AST-see).
 *   - R2 by SC present — every SC carried by a static finding pulls that SC's
 *     OTHER distilled failure shapes (what else hides behind a floor hit).
 *   - R3 by journey hint — a fixed path→tag map ({@link JOURNEY_HINTS}) over the
 *     scanned file paths boosts/filters patterns by their `journeyTags`.
 *
 * G0 ANCHOR: an empty union returns an empty slice — no grounding, so the caller
 * never invites a blind hunt (RFC G0). journeyTags stay retrieval-internal: they
 * drive R3 but never reach the returned shape.
 *
 * DECISION (RFC, approved 2026-06-16): `occasional`-tier patterns are
 * CONTEXT-ONLY — retrieved for grounding but NOT eligible to flag
 * (`eligibleToFlag: false`); only `very-common`/`common` may produce a finding.
 */

/** The slice cap — at most this many patterns ground one review (RFC N=20). */
export const SLICE_CAP = 20;

/**
 * Fixed path→journey-tag map for R3. Each entry tests the (lowercased) file path
 * of a scanned file; a match activates the journey tag, which boosts/filters
 * patterns carrying that tag. Deliberately small and closed — these are the
 * journeys the corpus actually tags (`checkout`, `sign-in`, `search`).
 */
const JOURNEY_HINTS: readonly { readonly pattern: RegExp; readonly tag: string }[] = [
  { pattern: /checkout|\bcart\b|payment/, tag: "checkout" },
  { pattern: /sign[-_]?in|log[-_]?in|\bauth\b|sso/, tag: "sign-in" },
  { pattern: /search/, tag: "search" },
];

/**
 * A retrieved pattern: the public {@link CorpusPattern} plus its FLAG ELIGIBILITY.
 * `eligibleToFlag` is false for `occasional` patterns (context-only) and true
 * for `very-common`/`common` — the only tiers permitted to surface a finding.
 */
export interface RetrievedPattern extends CorpusPattern {
  readonly eligibleToFlag: boolean;
}

/** The retrieved corpus slice — the grounding context for one review. */
export interface RetrievedSlice {
  readonly patterns: readonly RetrievedPattern[];
}

/** The inputs a retrieval reads: the scanned files plus the static scan outputs. */
export interface RetrieveInput {
  /** The scanned file paths — R3 reads these for the journey hint. */
  readonly files: readonly string[];
  /** The per-component resolutions (`scan().resolved.resolutions`) — R1. */
  readonly resolutions: readonly ComponentResolution[];
  /** The static findings (`scan().findings`) — R2 reads their SCs. */
  readonly findings: readonly Finding[];
}

/** Only these tiers may flag; `occasional` (and `unknown`) are context-only. */
const FLAGGABLE_TIERS: ReadonlySet<CorpusPattern["tier"]> = new Set(["very-common", "common"]);

/**
 * Token-overlap stopwords — connective/structural words in a pattern's prose
 * `component` label (`icon-only button`, `link to file / new context`) that carry
 * no element signal, so they must not produce a spurious overlap with a resolved
 * component name. Kept tiny: only words that recur as pure connective tissue.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "and",
  "or",
  "of",
  "to",
  "the",
  "with",
  "only",
  "new",
  "custom",
]);

/**
 * Split an identifier or prose label into lowercase alphanumeric tokens, also
 * breaking camelCase / PascalCase boundaries so `IconButton` → `icon` + `button`
 * overlaps the corpus label `icon-only button`. Stopwords are dropped.
 */
function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  // Insert a space at lower→Upper and letter→digit boundaries, then split on any
  // run of non-alphanumerics. `IconButton2` → `Icon Button2` → `icon`, `button2`.
  const spaced = text.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  for (const raw of spaced.split(/[^a-zA-Z0-9]+/)) {
    const tok = raw.trim().toLowerCase();
    if (tok === "" || STOPWORDS.has(tok)) continue;
    out.add(tok);
  }
  return out;
}

/**
 * The per-pattern component-token index (`id -> tokenize(component)`), cached
 * against the memoized `corpusPatterns()` array identity. The tokenize loop is
 * pure over immutable corpus data, so it runs once for the process and every
 * later review reuses the same index instead of re-tokenizing all ~100 patterns.
 */
let COMPONENT_TOKENS: { readonly source: readonly CorpusPattern[]; readonly byId: ReadonlyMap<string, Set<string>> } | undefined;

function componentTokens(all: readonly CorpusPattern[]): ReadonlyMap<string, Set<string>> {
  if (COMPONENT_TOKENS?.source === all) return COMPONENT_TOKENS.byId;
  const byId = new Map<string, Set<string>>();
  for (const p of all) byId.set(p.id, tokenize(p.component));
  COMPONENT_TOKENS = { source: all, byId };
  return byId;
}

/** Whether two token sets share at least one token. */
function overlaps(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  for (const t of a) {
    if (b.has(t)) return true;
  }
  return false;
}

/**
 * The journey tags active for this scan — every {@link JOURNEY_HINTS} tag whose
 * path regex matches at least one scanned file. R3 reads this set.
 */
function activeJourneyTags(files: readonly string[]): Set<string> {
  const tags = new Set<string>();
  for (const file of files) {
    const lower = file.toLowerCase();
    for (const { pattern, tag } of JOURNEY_HINTS) {
      if (pattern.test(lower)) tags.add(tag);
    }
  }
  return tags;
}

/**
 * Retrieve the in-context corpus slice that grounds one review. Pure: same input
 * → same slice. R1 ∪ R2 ∪ R3, deduped by id, capped at {@link SLICE_CAP} ordered
 * by frequency tier (very-common → common → occasional, ties by the corpus's own
 * stable order). G0: an empty union returns an empty slice.
 */
export function retrieveSlice(input: RetrieveInput): RetrievedSlice {
  const all = corpusPatterns();
  const journeyTags = corpusJourneyTags();
  // Precompute each pattern's component tokens ONCE — `corpusPatterns()` is a
  // memoized frozen singleton, so this `id -> tokens` index is cached against its
  // array identity and the tokenize loop runs only on the first review.
  const componentTokensById = componentTokens(all);
  // Stable rank by the corpus's own (tier, sc, id) order — the tie-break inside
  // a tier when the cap bites.
  const rank = new Map(all.map((p, i) => [p.id, i]));

  // R1 — resolved-component token overlap (incl. opaque/trusted: host is null
  // there, so only the name contributes).
  const resolutionTokens = input.resolutions.map((r) => {
    const toks = tokenize(r.name);
    if (r.host !== null) for (const t of tokenize(r.host)) toks.add(t);
    return toks;
  });

  // R2 — SCs carried by the static findings.
  const findingScs = new Set<string>();
  for (const f of input.findings) for (const sc of f.wcag) findingScs.add(sc);

  // R3 — journeys active for the scanned file paths.
  const active = activeJourneyTags(input.files);

  const matched = new Map<string, CorpusPattern>();
  for (const p of all) {
    const compTokens = componentTokensById.get(p.id) ?? tokenize(p.component);
    const r1 = resolutionTokens.some((rt) => overlaps(compTokens, rt));
    const r2 = findingScs.has(p.sc);
    const r3 =
      active.size > 0 && (journeyTags.get(p.id) ?? []).some((t) => active.has(t));
    if (r1 || r2 || r3) matched.set(p.id, p);
  }

  // G0 — empty union ⇒ empty slice. No grounding.
  if (matched.size === 0) return { patterns: [] };

  const ordered = [...matched.values()]
    .sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0))
    .slice(0, SLICE_CAP)
    .map((p) => ({ ...p, eligibleToFlag: FLAGGABLE_TIERS.has(p.tier) }));

  return { patterns: ordered };
}
