/**
 * The FREQUENCY-TIER contract: the vocabulary that maps a distinct-org count to
 * a named frequency tier. Public, non-moat — the thresholds are already
 * published in `data/baseline-rules.json`'s `_meta` and the tier names live in
 * the public `CorpusTier` type. What is proprietary is the org COUNTS and the
 * distilled patterns (the private `@binclusive/a11y-corpus`), not this mapping.
 *
 * The engine's home for the contract — statically importable, always present —
 * which is what lets `corpus.ts` degrade cleanly when the private corpus is
 * absent: the tier vocabulary never depends on the moat. The private
 * `@binclusive/a11y-corpus` distiller keeps its OWN copy pinned to the same
 * thresholds (it bakes `frequencyTier` into each shipped pattern) so it stays
 * independently extractable; the two are the same 3 public numbers, no build
 * edge between the packages.
 */

/** Frequency tiers derivable from an org count, strongest → weakest. */
export type FrequencyTier = "very-common" | "common" | "occasional";

/** k>=3 distinct orgs to keep a pattern (the distiller's frequency gate). */
export const MIN_ORGS = 3;

/** Frequency tier thresholds (distinct orgs). */
export const TIER_THRESHOLDS = { veryCommon: 15, common: 8, occasional: 3 } as const;

export function tierForOrgs(orgs: number): FrequencyTier {
  if (orgs >= TIER_THRESHOLDS.veryCommon) return "very-common";
  if (orgs >= TIER_THRESHOLDS.common) return "common";
  return "occasional";
}
