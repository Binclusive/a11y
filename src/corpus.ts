import patterns111 from "../data/corpus/patterns-1.1.1.json" with { type: "json" };
import patterns131 from "../data/corpus/patterns-1.3.1.json" with { type: "json" };
import patterns135 from "../data/corpus/patterns-1.3.5.json" with { type: "json" };
import patterns143 from "../data/corpus/patterns-1.4.3.json" with { type: "json" };
import patterns211 from "../data/corpus/patterns-2.1.1.json" with { type: "json" };
import patterns241 from "../data/corpus/patterns-2.4.1.json" with { type: "json" };
import patterns243 from "../data/corpus/patterns-2.4.3.json" with { type: "json" };
import patterns244 from "../data/corpus/patterns-2.4.4.json" with { type: "json" };
import patterns246 from "../data/corpus/patterns-2.4.6.json" with { type: "json" };
import patterns247 from "../data/corpus/patterns-2.4.7.json" with { type: "json" };
import patterns325 from "../data/corpus/patterns-3.2.5.json" with { type: "json" };
import patterns331 from "../data/corpus/patterns-3.3.1.json" with { type: "json" };
import patterns332 from "../data/corpus/patterns-3.3.2.json" with { type: "json" };
import patterns412 from "../data/corpus/patterns-4.1.2.json" with { type: "json" };
import patterns413 from "../data/corpus/patterns-4.1.3.json" with { type: "json" };
import snapshot from "../data/corpus-snapshot.json" with { type: "json" };
import type { Finding } from "./core";

/**
 * Corpus tiers, ordered by frequency. `unknown` is the floor: the finding's
 * WCAG SC has no entry in the snapshot (or the rule had no SC mapping at all).
 */
export type CorpusTier = "very-common" | "common" | "occasional" | "unknown";

/**
 * A distilled, anonymized failure pattern for an SC — the richer corpus
 * evidence produced by the distillation pipeline (see `src/distill/`). Multiple
 * patterns can belong to one SC; they are surfaced alongside the SC-level
 * evidence so a report can show the specific failure shapes seen in the wild.
 */
export interface DistilledPatternRef {
  readonly id: string;
  readonly component: string;
  readonly failureShape: string;
  readonly fix: string;
  readonly frequencyTier: CorpusTier;
  readonly journeyTags: readonly string[];
}

/**
 * The corpus evidence attached to a finding: which SC matched, how widespread
 * it is in the dynamic-audit corpus, and the representative fix. `tier`
 * `"unknown"` means no snapshot match — `sc`/`orgs`/`fix` are null in that case.
 * `patterns` carries the distilled per-failure-shape evidence for the matched
 * SC (empty when the SC hasn't been distilled yet).
 */
export interface CorpusEvidence {
  readonly sc: string | null;
  readonly tier: CorpusTier;
  readonly orgs: number | null;
  readonly fix: string | null;
  readonly patterns: readonly DistilledPatternRef[];
}

/** A finding plus its corpus cross-reference. */
export interface EnrichedFinding extends Finding {
  readonly corpus: CorpusEvidence;
}

interface CriterionEntry {
  readonly orgs: number;
  readonly tier: CorpusTier;
  readonly fix: string;
}

/**
 * The snapshot is loaded as `unknown` at the JSON boundary and narrowed here.
 * We index `criteria` by SC string; values are validated structurally before
 * use so a malformed snapshot fails loud rather than smuggling `any` inward.
 */
function readCriteria(raw: unknown): ReadonlyMap<string, CriterionEntry> {
  const map = new Map<string, CriterionEntry>();
  if (typeof raw !== "object" || raw === null || !("criteria" in raw)) return map;
  const criteria = (raw as { criteria: unknown }).criteria;
  if (typeof criteria !== "object" || criteria === null) return map;

  for (const [sc, value] of Object.entries(criteria)) {
    if (typeof value !== "object" || value === null) continue;
    const { orgs, tier, fix } = value as Record<string, unknown>;
    if (typeof orgs !== "number" || typeof fix !== "string") continue;
    if (tier !== "very-common" && tier !== "common" && tier !== "occasional") continue;
    map.set(sc, { orgs, tier, fix });
  }
  return map;
}

const CRITERIA = readCriteria(snapshot);

/**
 * Narrow a distilled `patterns-<SC>.json` file (loaded as `unknown` at the JSON
 * boundary) into a map of SC -> patterns. Each pattern is validated structurally
 * so a malformed file fails loud rather than smuggling `any` inward.
 */
function readDistilled(...files: unknown[]): ReadonlyMap<string, DistilledPatternRef[]> {
  const map = new Map<string, DistilledPatternRef[]>();
  const isTier = (t: unknown): t is CorpusTier =>
    t === "very-common" || t === "common" || t === "occasional" || t === "unknown";

  for (const file of files) {
    if (typeof file !== "object" || file === null || !("patterns" in file)) continue;
    const list = (file as { patterns: unknown }).patterns;
    if (!Array.isArray(list)) continue;
    for (const p of list) {
      if (typeof p !== "object" || p === null) continue;
      const { id, wcag, component, failureShape, fix, frequencyTier, journeyTags } = p as Record<
        string,
        unknown
      >;
      if (
        typeof id !== "string" ||
        !Array.isArray(wcag) ||
        typeof component !== "string" ||
        typeof failureShape !== "string" ||
        typeof fix !== "string" ||
        !isTier(frequencyTier)
      ) {
        continue;
      }
      const tags = Array.isArray(journeyTags)
        ? journeyTags.filter((t): t is string => typeof t === "string")
        : [];
      const ref: DistilledPatternRef = {
        id,
        component,
        failureShape,
        fix,
        frequencyTier,
        journeyTags: tags,
      };
      for (const sc of wcag) {
        if (typeof sc !== "string") continue;
        const bucket = map.get(sc) ?? [];
        bucket.push(ref);
        map.set(sc, bucket);
      }
    }
  }
  return map;
}

const DISTILLED = readDistilled(
  patterns111,
  patterns131,
  patterns135,
  patterns143,
  patterns211,
  patterns241,
  patterns243,
  patterns244,
  patterns246,
  patterns247,
  patterns325,
  patterns331,
  patterns332,
  patterns412,
  patterns413,
);

/**
 * Cross-reference a finding against the corpus snapshot by WCAG SC.
 *
 * A finding can carry several SC (e.g. label issues are both 1.3.1 and 4.1.2);
 * we attach the most-widespread matching SC so the report leads with the
 * highest-impact framing. No match (or no SC at all) yields tier `"unknown"` —
 * the finding still reports, it just carries no corpus evidence.
 */
export function enrich(finding: Finding): EnrichedFinding {
  let best: { sc: string; entry: CriterionEntry } | null = null;
  for (const sc of finding.wcag) {
    const entry = CRITERIA.get(sc);
    if (entry === undefined) continue;
    if (best === null || entry.orgs > best.entry.orgs) {
      best = { sc, entry };
    }
  }

  if (best === null) {
    return {
      ...finding,
      corpus: { sc: null, tier: "unknown", orgs: null, fix: null, patterns: [] },
    };
  }
  return {
    ...finding,
    corpus: {
      sc: best.sc,
      tier: best.entry.tier,
      orgs: best.entry.orgs,
      fix: best.entry.fix,
      patterns: DISTILLED.get(best.sc) ?? [],
    },
  };
}

/** Enrich a batch of findings. */
export function enrichAll(findings: readonly Finding[]): EnrichedFinding[] {
  return findings.map(enrich);
}

/** A corpus SC entry surfaced for contract generation: SC + frequency + fix. */
export interface CorpusCriterion {
  readonly sc: string;
  readonly orgs: number;
  readonly tier: CorpusTier;
  readonly fix: string;
}

/**
 * Every corpus SC, ordered most-widespread first. This is the source of truth
 * the contract layer reads from: enforcement defaults split on `tier`, and the
 * AGENTS.md block leads with the top SC. Pure data — no finding required.
 */
export function corpusCriteria(): readonly CorpusCriterion[] {
  return [...CRITERIA.entries()]
    .map(([sc, e]) => ({ sc, orgs: e.orgs, tier: e.tier, fix: e.fix }))
    .sort((a, b) => b.orgs - a.orgs);
}

/**
 * A distilled corpus pattern surfaced for the AGENTS.md block: the real
 * failure-shape moat (51 patterns from `data/corpus/patterns-*.json`), not the
 * seed snapshot. `sc` is the pattern's most-widespread WCAG SC; `orgs` is that
 * SC's snapshot-level aggregate (safe to show); `frequencyTier` is the
 * pattern's own distilled tier.
 */
export interface CorpusPattern {
  readonly id: string;
  readonly sc: string;
  readonly orgs: number | null;
  readonly tier: CorpusTier;
  readonly component: string;
  readonly failureShape: string;
  readonly fix: string;
}

const TIER_RANK: Record<CorpusTier, number> = {
  "very-common": 0,
  common: 1,
  occasional: 2,
  unknown: 3,
};

/**
 * Every distilled pattern, deduped by id and ordered by frequency tier
 * (very-common → common → occasional) then SC then id for a stable diff.
 *
 * A pattern can appear under several SC in `DISTILLED` (it's keyed per-SC); we
 * attach the SC under which it is most widespread — same "lead with the
 * highest-impact framing" rule `enrich` uses — and carry that SC's aggregate
 * org count from the snapshot. Pure data; the AGENTS.md generator reads this.
 */
export function corpusPatterns(): readonly CorpusPattern[] {
  // Pick the most-widespread SC per pattern id (most orgs; tie → lowest SC).
  const bySc = new Map<string, { ref: DistilledPatternRef; sc: string; orgs: number | null }>();
  for (const [sc, refs] of DISTILLED.entries()) {
    const orgs = CRITERIA.get(sc)?.orgs ?? null;
    for (const ref of refs) {
      const existing = bySc.get(ref.id);
      const better =
        existing === undefined ||
        (orgs ?? -1) > (existing.orgs ?? -1) ||
        ((orgs ?? -1) === (existing.orgs ?? -1) && sc < existing.sc);
      if (better) bySc.set(ref.id, { ref, sc, orgs });
    }
  }

  return [...bySc.values()]
    .map(({ ref, sc, orgs }) => ({
      id: ref.id,
      sc,
      orgs,
      tier: ref.frequencyTier,
      component: ref.component,
      failureShape: ref.failureShape,
      fix: ref.fix,
    }))
    .sort((a, b) => {
      const t = TIER_RANK[a.tier] - TIER_RANK[b.tier];
      if (t !== 0) return t;
      if (a.sc !== b.sc) return a.sc < b.sc ? -1 : 1;
      return a.id < b.id ? -1 : 1;
    });
}
