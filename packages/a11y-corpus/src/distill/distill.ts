/**
 * The distillation engine: raw corpus findings -> anonymized, k>=3, generalized
 * patterns + a no-silent-drops ledger.
 *
 * The CLUSTERING (which findings are the same failure-shape) is done OFF-LINE by
 * the LLM and committed as `data/clusters/clusters-<SC>.json` (see
 * `cluster-assignments.ts`). This engine consumes those frozen assignments; it
 * does NOT cluster. Everything here is deterministic CODE:
 *
 *   1. normalize each finding's wcag_criterion -> canonical SC(s)
 *   2. look up the finding's cluster via the LLM-authored assignment map
 *      (finding id -> cluster id) for each in-scope SC
 *   3. count DISTINCT org_id per cluster (org_id is used ONLY here for the
 *      frequency gate — it never reaches the output)
 *   4. keep clusters seen at >= MIN_ORGS distinct orgs; assign a frequency tier
 *   5. derive journeyTags from the data (categorized journeys observed for the
 *      cluster), falling back to the cluster's authored defaults
 *
 * Everything dropped (junk SC, unassigned, below-k) is counted in the ledger.
 */

import type { ClusterDef, ParsedClusters } from "./cluster-assignments";
import { categorizeJourney, type JourneyCategory } from "./journey-category";
import { normalizeCriterion } from "./normalize-sc";

// The frequency-tier contract is DELIBERATELY duplicated here and in the OSS
// engine (`@binclusive/a11y/src/frequency-tier`). Both are pinned to the same
// public thresholds (also documented in `data/baseline-rules.json` _meta). The
// copy keeps this private moat package independently extractable — no build-time
// edge to the engine — which is the whole point of the public/private split.

/** k>=3 distinct orgs to keep a pattern. */
export const MIN_ORGS = 3;

/** Frequency tier thresholds (distinct orgs). */
export const TIER_THRESHOLDS = { veryCommon: 15, common: 8, occasional: 3 } as const;
export type FrequencyTier = "very-common" | "common" | "occasional";

export function tierForOrgs(orgs: number): FrequencyTier {
  if (orgs >= TIER_THRESHOLDS.veryCommon) return "very-common";
  if (orgs >= TIER_THRESHOLDS.common) return "common";
  return "occasional";
}

/** The minimal raw fields the distiller reads. */
export interface RawFinding {
  /** Opaque corpus finding id (`avt_*`) — the join key to cluster assignments. */
  readonly id: string;
  readonly wcag_criterion: string | null;
  readonly org_id: string | null;
  readonly journey_name: string | null;
  readonly journey_step: string | null;
}

/** A shipped, anonymized pattern (the output shape). */
export interface DistilledPattern {
  readonly id: string;
  readonly wcag: readonly string[];
  readonly component: string;
  readonly failureShape: string;
  readonly fix: string;
  readonly frequencyTier: FrequencyTier;
  readonly journeyTags: readonly JourneyCategory[];
}

/** Why a finding (or whole cluster) was dropped — the no-silent-drops ledger. */
export interface DropLedger {
  /** Findings whose criterion canonicalized to nothing. */
  readonly unmappableCriterion: number;
  /** Findings in an in-scope SC that the LLM assigned to no cluster. */
  readonly unclassified: number;
  /** Clusters that matched findings but at < MIN_ORGS distinct orgs. */
  readonly belowK: ReadonlyArray<{ id: string; orgs: number; findings: number }>;
  /** Findings whose SC is not in scope for this run (no cluster file). */
  readonly scOutOfScope: number;
}

export interface DistillResult {
  readonly patterns: readonly DistilledPattern[];
  readonly ledger: DropLedger;
  /** Total raw findings processed. */
  readonly totalFindings: number;
  /** Distinct orgs across all processed findings (corpus breadth). */
  readonly totalOrgs: number;
}

interface Accum {
  readonly def: ClusterDef;
  readonly orgs: Set<string>;
  readonly journeys: Map<JourneyCategory, number>;
  findings: number;
}

/**
 * Distill the given raw findings using the LLM-authored cluster assignments,
 * one {@link ParsedClusters} per in-scope SC (keyed by SC). Findings whose SC
 * has no cluster file are counted as out-of-scope in the ledger, not lost.
 *
 * `org_id` is read only to count distinct orgs per cluster (the k>=3 gate) and
 * is stripped before output. The cluster prose (component/failureShape/fix) is
 * the already-anonymized LLM artifact, copied verbatim.
 */
export function distill(
  rawFindings: readonly RawFinding[],
  clustersBySC: ReadonlyMap<string, ParsedClusters>,
): DistillResult {
  const scope = clustersBySC;
  const accums = new Map<string, Accum>();
  const allOrgs = new Set<string>();
  let unmappableCriterion = 0;
  let unclassified = 0;
  let scOutOfScope = 0;

  for (const f of rawFindings) {
    if (f.org_id !== null) allOrgs.add(f.org_id);

    const scs = normalizeCriterion(f.wcag_criterion);
    if (scs.length === 0) {
      unmappableCriterion++;
      continue;
    }

    // A finding can carry several SC (multi-code blob). Resolve under each
    // in-scope SC; if none of its SCs are in scope, it's out of scope.
    const inScope = scs.filter((sc) => scope.has(sc));
    if (inScope.length === 0) {
      scOutOfScope++;
      continue;
    }

    let claimedSomewhere = false;
    for (const sc of inScope) {
      const parsed = scope.get(sc);
      if (parsed === undefined) continue;
      const clusterId = parsed.assignments.get(f.id);
      if (clusterId === undefined) continue;
      const def = parsed.defsById.get(clusterId);
      if (def === undefined) continue; // parseClusterFile already guarantees this can't happen
      claimedSomewhere = true;

      const acc = accums.get(def.id) ?? {
        def,
        orgs: new Set<string>(),
        journeys: new Map<JourneyCategory, number>(),
        findings: 0,
      };
      acc.findings++;
      if (f.org_id !== null) acc.orgs.add(f.org_id);
      const cat = categorizeJourney(f.journey_name, f.journey_step);
      acc.journeys.set(cat, (acc.journeys.get(cat) ?? 0) + 1);
      accums.set(def.id, acc);
    }
    if (!claimedSomewhere) unclassified++;
  }

  const patterns: DistilledPattern[] = [];
  const belowK: Array<{ id: string; orgs: number; findings: number }> = [];

  for (const acc of accums.values()) {
    const orgCount = acc.orgs.size;
    if (orgCount < MIN_ORGS) {
      belowK.push({ id: acc.def.id, orgs: orgCount, findings: acc.findings });
      continue;
    }
    patterns.push({
      id: acc.def.id,
      wcag: acc.def.wcag,
      component: acc.def.component,
      failureShape: acc.def.failureShape,
      fix: acc.def.fix,
      frequencyTier: tierForOrgs(orgCount),
      journeyTags: deriveJourneyTags(acc),
    });
  }

  // Stable order: most-widespread first (tier), then id.
  patterns.sort((a, b) => {
    const t = tierRank(b.frequencyTier) - tierRank(a.frequencyTier);
    if (t !== 0) return t;
    return a.id.localeCompare(b.id);
  });

  // Stable ledger order so re-runs diff cleanly.
  belowK.sort((a, b) => a.id.localeCompare(b.id));

  return {
    patterns,
    ledger: { unmappableCriterion, unclassified, belowK, scOutOfScope },
    totalFindings: rawFindings.length,
    totalOrgs: allOrgs.size,
  };
}

function tierRank(tier: FrequencyTier): number {
  return tier === "very-common" ? 3 : tier === "common" ? 2 : 1;
}

/** Cap on how many journey tags a pattern ships — keep the top signal, not noise. */
const MAX_JOURNEY_TAGS = 4;

/**
 * Journey tags for a pattern, DERIVED from the data: the journey categories
 * actually observed for it, dropping the catch-all `other`, sorted by how often
 * they appeared, and capped to the top {@link MAX_JOURNEY_TAGS}. Only when the
 * pattern was never seen with a recognizable journey do we fall back to its
 * authored defaults. Tags reflect real corpus journeys, not authored padding.
 * No raw journey text leaves this function — only the closed enum.
 */
function deriveJourneyTags(acc: Accum): JourneyCategory[] {
  const observed = [...acc.journeys.entries()]
    .filter(([cat]) => cat !== "other")
    .sort((a, b) => b[1] - a[1])
    .map(([cat]) => cat);
  const chosen = observed.length > 0 ? observed : [...acc.def.journeyTags];
  return chosen.slice(0, MAX_JOURNEY_TAGS);
}
