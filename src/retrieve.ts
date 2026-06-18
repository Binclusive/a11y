import { type CorpusPattern, corpusJourneyTags, corpusPatterns } from "./corpus";
import type { Finding } from "./core";
import type { IntrinsicElement, IntrinsicSignals } from "./intrinsic-elements";
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
  /**
   * The INTRINSIC (lowercase-tag) elements in the scanned files
   * (`collectIntrinsicElements`) — R4 reads their tag + coarse content signal.
   * The caller does the one walk (it already holds the parse), keeping this
   * retriever AST-free and pure. Absent ⇒ R4 contributes nothing (back-compat).
   */
  readonly intrinsics?: readonly IntrinsicElement[];
}

/**
 * Only these tiers may flag; `occasional` (and `unknown`) are context-only.
 *
 * Eligibility rides the FROZEN per-pattern `frequencyTier` (per-pattern is the
 * granularity detection needs — the live SC tier is coarser, per-SC). Exported so
 * the drift guard (`test/retrieve.test.ts`) can assert every pattern this set
 * admits via its frozen tier is ALSO flaggable under its SC's LIVE tier
 * (`corpusCriteria()`), catching the latent staleness the RFC flagged: a
 * regenerated corpus that demotes an SC while the frozen per-pattern tier keeps
 * `eligibleToFlag` true.
 */
export const FLAGGABLE_TIERS: ReadonlySet<CorpusPattern["tier"]> = new Set([
  "very-common",
  "common",
]);

/**
 * The recall patterns whose PRECISION is certified — a STRICT SUBSET of
 * `eligibleToFlag`. Tier-eligibility says "this pattern MAY flag"; certification
 * (`test/recall-certification.test.ts`, pooled Wilson >= 0.95, zero decoy leaks)
 * says "we have MEASURED its precision". The edit-time hook's advisory self-check
 * surfaces only these, so it never nudges the model toward an unmeasured pattern
 * (e.g. a keyboard pattern R1 pulls in via a shared `link` token). Kept in lockstep
 * with the positive certification fixtures by an assertion in that test — adding a
 * pattern here without certifying it (or vice-versa) fails the build.
 */
export const CERTIFIED_RECALL_PATTERN_IDS: ReadonlySet<string> = new Set([
  "2.4.4-generic-link-text",
  "2.4.4-noisy-or-wrong-name",
  // R4 (intrinsic `<img>`): a present-but-bad alt (filename / id / placeholder) —
  // floor-clean (alt IS present) and un-retrievable before R4 (no import).
  "1.1.1-filename-or-generic-alt",
]);

/**
 * R4 — the EXPLICIT intrinsic-tag → corpus-pattern-id table (RFC
 * `r4-content-inspection-retriever`, §4). The deliberate OPPOSITE of R1's token
 * overlap: an `<img>` grounds image patterns because THIS TABLE says so, never
 * because a word matched. That is what makes R4 leak-proof — the F6 cross-kind
 * overlap (an `image`/`icon` token pulling a LINK pattern into a button slice)
 * has no path here: a tag resolves to EXACTLY the ids under its key, and a human
 * put each one there. Right pattern-set or empty, never wrong-pattern — the
 * intrinsic-element analogue of the resolver's "correct host or stay opaque".
 *
 * Only CONTENT-QUALITY / non-floor shapes belong here — the static floor already
 * owns the hard-missing cases (no-alt, no-name). `when` is the per-pattern
 * CONTENT-PREMISE predicate (§4.4): a pattern is unioned only when the element's
 * coarse signal is consistent with that pattern's premise (e.g.
 * `1.1.1-filename-or-generic-alt` is about a present-but-bad alt, so it requires
 * `altState === "present"` — a missing-alt `<img>` is a FLOOR case). Predicate-
 * less rows are `occasional`-tier context-only entries (never flag, retrieved so
 * the agent's slice is complete); `when: () => true` is implied where omitted.
 */
interface R4Entry {
  readonly id: string;
  /** The content premise that must hold for this id to be unioned (default: always). */
  readonly when?: (s: IntrinsicSignals) => boolean;
}

export const R4_ELEMENT_PATTERNS: Record<string, readonly R4Entry[]> = {
  img: [
    // common — alt present but a filename / id / placeholder. THE headline win.
    { id: "1.1.1-filename-or-generic-alt", when: (s) => s.altState === "present" },
    // occasional (context-only — never flags): verbose / redundant, or wrong alt.
    { id: "1.1.1-alt-too-long-or-redundant" },
    { id: "1.1.1-alt-wrong-or-insufficient" },
  ],
  a: [
    // common — visible text present but non-descriptive ("click here", "read more").
    { id: "2.4.4-generic-link-text", when: (s) => s.hasVisibleText },
    // common — visible text present but polluted (raw URL / path / filename / SKU).
    { id: "2.4.4-noisy-or-wrong-name", when: (s) => s.hasVisibleText },
    // occasional (context-only): a new-window link that doesn't signal the change.
    { id: "3.2.5-new-window-not-signaled" },
  ],
  // Content-quality button shapes are floor-owned (no-name) or trusted-component
  // state (selected/expanded) — no common, intrinsic, floor-missed, certifiable
  // button content pattern today. `button` maps to [] (the F6 row stays empty).
  button: [],
};

/**
 * Token-overlap stopwords — connective/structural words in a pattern's prose
 * `component` label (`icon-only button`, `link to file / new context`) that carry
 * no element signal, so they must not produce a spurious overlap with a resolved
 * component name. Kept tiny: only words that recur as pure connective tissue.
 *
 * `icon`, `image`, `empty` are stopworded for a SHARPER reason: they are generic
 * descriptors shared across control KINDS (icon-only button, icon/image/empty
 * link, generic alt image), not element signal. Matching on them cross-pollinates
 * a slice with patternIds the resolved element can NEVER be — e.g. an `IconButton`
 * (tokens include `icon`) would otherwise overlap the LINK pattern
 * `2.4.4-link-no-name` ("icon / image / empty link") and admit a link pattern into
 * a button-only slice as eligibleToFlag. The KIND tokens (`button`, `link`,
 * `social`, `media`, `image`-bearing patterns still keyed by `link`/`alt`) keep
 * every pattern reachable from its genuine resolution; only the cross-kind leak
 * is closed.
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
  "icon",
  "image",
  "empty",
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

  // R4 — explicit intrinsic-tag → pattern-id table, gated by each id's content
  // premise (§4.4). An id is admitted only when SOME intrinsic element of that tag
  // satisfies the id's `when` predicate, so `1.1.1-filename-or-generic-alt` enters
  // only on a present-alt `<img>` (a missing-alt one is a floor case, never R4).
  const r4Ids = new Set<string>();
  for (const el of input.intrinsics ?? []) {
    for (const entry of R4_ELEMENT_PATTERNS[el.tag] ?? []) {
      if (entry.when === undefined || entry.when(el.signals)) r4Ids.add(entry.id);
    }
  }

  const matched = new Map<string, CorpusPattern>();
  for (const p of all) {
    const compTokens = componentTokensById.get(p.id) ?? tokenize(p.component);
    const r1 = resolutionTokens.some((rt) => overlaps(compTokens, rt));
    const r2 = findingScs.has(p.sc);
    const r3 =
      active.size > 0 && (journeyTags.get(p.id) ?? []).some((t) => active.has(t));
    const r4 = r4Ids.has(p.id);
    if (r1 || r2 || r3 || r4) matched.set(p.id, p);
  }

  // G0 — empty union ⇒ empty slice. No grounding.
  if (matched.size === 0) return { patterns: [] };

  const ordered = [...matched.values()]
    .sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0))
    .slice(0, SLICE_CAP)
    .map((p) => ({ ...p, eligibleToFlag: FLAGGABLE_TIERS.has(p.tier) }));

  return { patterns: ordered };
}
