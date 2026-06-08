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
import baselineCatalog from "../data/baseline-rules.json" with { type: "json" };
import snapshot from "../data/corpus-snapshot.json" with { type: "json" };
import type { Finding } from "./core";

/** Severity levels, ordered least → most severe. axe's runtime impact vocabulary. */
export type Severity = "minor" | "moderate" | "serious" | "critical";

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
 * The evidence attached to a finding. `source` is the discriminator between the
 * two NON-OVERLAPPING sources of truth — they never mix:
 *
 *   - `"audit"`    — matched the real-audit corpus snapshot (`data/corpus-snapshot.json`).
 *                    Carries `orgs` (the real org count) and a real frequency `tier`.
 *                    This is the moat: truthful, partial (~15 SCs).
 *   - `"baseline"` — no corpus match, but axe-core's baseline catalog
 *                    (`data/baseline-rules.json`) knows the rule. Carries axe's
 *                    `severity` + standard `fix` + `helpUrl`, and `orgs: null`,
 *                    `tier: "unknown"` (it is NOT audit-frequency data). Matched by
 *                    the finding's SC, OR — for axe best-practice rules that carry
 *                    no WCAG SC tag (`region`, `landmark-unique`, …) — by the axe
 *                    ruleId, in which case `sc` is null and `bestPractice` is true.
 *                    This is the coverage layer: every axe rule surfaces with a
 *                    severity and a fix even if the corpus has never seen it.
 *   - `"none"`     — the finding's ruleId is genuinely absent from the catalog
 *                    (and no SC matched). The finding still reports; it just
 *                    carries no catalog evidence.
 *
 * `tier`/`orgs`/`patterns` are corpus-only and meaningful only when
 * `source === "audit"`. `severity`/`helpUrl` are populated for `"baseline"` (and
 * for axe findings, carried straight off the finding's runtime axe metadata).
 * `bestPractice` is true only for a baseline-by-ruleId match with no WCAG SC —
 * an axe recommendation that is NOT a WCAG failure, so it must not be dressed up
 * with a fabricated SC.
 */
export interface CorpusEvidence {
  readonly source: "audit" | "baseline" | "none";
  readonly sc: string | null;
  readonly tier: CorpusTier;
  readonly orgs: number | null;
  readonly fix: string | null;
  readonly patterns: readonly DistilledPatternRef[];
  /**
   * Severity for this finding. From axe's runtime impact on an axe finding, else
   * axe's published default impact for the rule (baseline catalog). Null when no
   * baseline rule knows the SC and the finding carried no runtime impact.
   */
  readonly severity: Severity | null;
  /** axe's Deque-University help URL for the rule, when the baseline knows it. */
  readonly helpUrl: string | null;
  /**
   * True only when this is a baseline match for an axe best-practice rule that
   * carries NO WCAG SC (matched by ruleId, `sc === null`). It is an axe
   * recommendation, not a WCAG conformance failure — surfaced honestly, never
   * with a forced SC.
   */
  readonly bestPractice: boolean;
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
 * A baseline-catalog rule, narrowed from `data/baseline-rules.json`. Mirrors the
 * generator's `BaselineRule` shape. This is the COVERAGE source of truth (axe's
 * published per-rule metadata) — distinct from the audit corpus above; it never
 * carries an org count or a frequency tier.
 */
interface BaselineRuleEntry {
  readonly ruleId: string;
  readonly sc: readonly string[];
  readonly severity: Severity;
  readonly help: string;
  readonly helpUrl: string;
}

/**
 * Narrow the baseline catalog (loaded as `unknown` at the JSON boundary) into
 * two indexes: by axe ruleId (for axe findings, the exact rule) and by SC (for
 * source-pass findings, which carry an SC but no axe ruleId). For an SC mapped by
 * several rules, the first in the catalog's deterministic (ruleId-sorted) order
 * wins — stable across regenerations. Each entry is validated structurally so a
 * malformed file fails loud rather than smuggling `any` inward.
 */
function readBaseline(raw: unknown): {
  byRule: ReadonlyMap<string, BaselineRuleEntry>;
  bySc: ReadonlyMap<string, BaselineRuleEntry>;
} {
  const byRule = new Map<string, BaselineRuleEntry>();
  const bySc = new Map<string, BaselineRuleEntry>();
  const isSeverity = (s: unknown): s is Severity =>
    s === "minor" || s === "moderate" || s === "serious" || s === "critical";

  if (typeof raw !== "object" || raw === null || !("rules" in raw)) return { byRule, bySc };
  const list = (raw as { rules: unknown }).rules;
  if (!Array.isArray(list)) return { byRule, bySc };

  for (const r of list) {
    if (typeof r !== "object" || r === null) continue;
    const { ruleId, sc, severity, help, helpUrl } = r as Record<string, unknown>;
    if (
      typeof ruleId !== "string" ||
      !Array.isArray(sc) ||
      !isSeverity(severity) ||
      typeof help !== "string" ||
      typeof helpUrl !== "string"
    ) {
      continue;
    }
    const scList = sc.filter((s): s is string => typeof s === "string");
    const entry: BaselineRuleEntry = { ruleId, sc: scList, severity, help, helpUrl };
    byRule.set(ruleId, entry);
    for (const oneSc of scList) {
      if (!bySc.has(oneSc)) bySc.set(oneSc, entry);
    }
  }
  return { byRule, bySc };
}

const BASELINE = readBaseline(baselineCatalog);

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
 * Find the first of a finding's SCs that the baseline catalog knows, with the
 * matched entry. Source-pass findings (jsx-a11y / enforce) and WCAG-tagged axe
 * findings resolve here. Finding order is preserved (first known SC wins).
 */
function baselineBySc(finding: Finding): { sc: string; entry: BaselineRuleEntry } | null {
  for (const sc of finding.wcag) {
    const entry = BASELINE.bySc.get(sc);
    if (entry !== undefined) return { sc, entry };
  }
  return null;
}

/**
 * Cross-reference a finding against the evidence sources, most-authoritative
 * first, so every finding surfaces with a severity and a fix instead of
 * dead-ending at `unknown`/null:
 *
 *   1. AUDIT corpus (by SC) — the moat. A finding can carry several SC (label
 *      issues are both 1.3.1 and 4.1.2); attach the most-widespread matching SC
 *      so the report leads with the highest-impact framing. → `source: "audit"`,
 *      real `orgs` + `tier`, distilled patterns.
 *   2. BASELINE (by SC) — coverage for WCAG SCs the corpus has never seen. axe's
 *      published per-rule severity + standard fix + helpUrl. → `source: "baseline"`,
 *      `orgs: null`, `tier: "unknown"`, `bestPractice: false`.
 *   3. BASELINE (by ruleId) — the axe best-practice rules that carry NO WCAG SC
 *      tag (`region`, `landmark-unique`, …). Matched by the finding's axe ruleId,
 *      reported honestly: `sc: null`, `bestPractice: true`, still carrying
 *      severity + fix + helpUrl. → `source: "baseline"`.
 *   4. NONE — the ruleId is genuinely absent from the catalog (and no SC
 *      matched). An axe finding may still surface its own runtime severity/helpUrl.
 *
 * For axe findings the runtime impact already on the finding always wins over
 * the catalog's static severity.
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

  // 1. AUDIT — the real-frequency moat. Severity still comes from the finding's
  //    own runtime axe impact when present (an axe finding), else the baseline's
  //    published default for the matched SC; helpUrl likewise from baseline.
  if (best !== null) {
    const baseline = BASELINE.bySc.get(best.sc);
    return {
      ...finding,
      corpus: {
        source: "audit",
        sc: best.sc,
        tier: best.entry.tier,
        orgs: best.entry.orgs,
        fix: best.entry.fix,
        patterns: DISTILLED.get(best.sc) ?? [],
        severity: finding.severity ?? baseline?.severity ?? null,
        helpUrl: finding.helpUrl ?? baseline?.helpUrl ?? null,
        bestPractice: false,
      },
    };
  }

  // 2. BASELINE by SC — coverage for WCAG SCs the corpus has never distilled.
  const bySc = baselineBySc(finding);
  if (bySc !== null) {
    return {
      ...finding,
      corpus: {
        source: "baseline",
        sc: bySc.sc,
        tier: "unknown",
        orgs: null,
        fix: bySc.entry.help,
        patterns: [],
        // Runtime axe impact (most accurate) wins over the catalog default.
        severity: finding.severity ?? bySc.entry.severity,
        helpUrl: finding.helpUrl ?? bySc.entry.helpUrl,
        bestPractice: false,
      },
    };
  }

  // 3. BASELINE by ruleId — axe best-practice rules with NO WCAG SC tag. The
  //    catalog knows the rule even though `bySc` missed; report it honestly with
  //    `sc: null` + `bestPractice: true` rather than dropping to UNMAPPED.
  const byRule = BASELINE.byRule.get(finding.ruleId);
  if (byRule !== undefined) {
    // A catalog rule WITH an SC should have matched by SC above; if we reach here
    // it has no WCAG SC, so this is a best-practice recommendation.
    return {
      ...finding,
      corpus: {
        source: "baseline",
        sc: byRule.sc[0] ?? null,
        tier: "unknown",
        orgs: null,
        fix: byRule.help,
        patterns: [],
        severity: finding.severity ?? byRule.severity,
        helpUrl: finding.helpUrl ?? byRule.helpUrl,
        bestPractice: byRule.sc.length === 0,
      },
    };
  }

  // 4. NONE — the ruleId is absent from the catalog. An axe finding may still
  //    carry its own runtime severity/helpUrl off the finding itself.
  return {
    ...finding,
    corpus: {
      source: "none",
      sc: null,
      tier: "unknown",
      orgs: null,
      fix: null,
      patterns: [],
      severity: finding.severity ?? null,
      helpUrl: finding.helpUrl ?? null,
      bestPractice: false,
    },
  };
}

/** Enrich a batch of findings. */
export function enrichAll(findings: readonly Finding[]): EnrichedFinding[] {
  return findings.map(enrich);
}

/**
 * The rule-accurate fix string to display/emit for a finding — the single seam
 * the CLI report and the MCP `CheckFinding` both read so they never disagree.
 *
 * For a `provenance === "axe"` (rendered-DOM) finding the corpus `fix` is the
 * SC-GENERIC fix, written for that SC's most-common failure (1.1.1 → missing
 * image alt). But one SC spans many axe rules with different failure modes
 * (`aria-progressbar-name` is also 1.1.1), so the SC-generic fix contradicts the
 * rule. axe's OWN per-rule guidance is rule-accurate, so for axe findings the
 * displayed fix is axe's: the per-rule `message` (axe help), null when even that
 * is absent. The Deque help page (`corpus.helpUrl`) is the canonical fix link
 * and is surfaced alongside as `ref`.
 *
 * For source-pass findings (`jsx-a11y` / `enforce`) the corpus `fix` is kept
 * exactly as-is: their rule↔SC mapping is clean via wcag-map, so the SC-keyed
 * corpus fix is rule-accurate.
 */
export function displayFix(f: EnrichedFinding): string | null {
  if (f.provenance === "axe") return f.message ?? null;
  return f.corpus.fix;
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

/**
 * A baseline-catalog rule surfaced for `get_a11y_rules`: axe's published
 * per-rule data (ruleId, SC, severity, standard fix, helpUrl) for ANY axe/WCAG
 * rule — the coverage answer when the distilled patterns don't cover what was
 * asked. Carries NO org count and NO frequency tier (it is not audit data).
 */
export interface BaselineRuleInfo {
  readonly ruleId: string;
  readonly sc: readonly string[];
  readonly severity: Severity;
  readonly fix: string;
  readonly helpUrl: string;
}

/**
 * Look up baseline rules by axe ruleId substring and/or WCAG SC. With no filter,
 * returns the whole catalog (already ruleId-sorted, deterministic). This lets an
 * agent ask "rules for color-contrast" and get the baseline entry even when the
 * corpus has no distilled pattern for it. Pure read over `baseline-rules.json`.
 */
export function baselineRules(filter: { ruleId?: string; sc?: string } = {}): BaselineRuleInfo[] {
  const toInfo = (e: BaselineRuleEntry): BaselineRuleInfo => ({
    ruleId: e.ruleId,
    sc: e.sc,
    severity: e.severity,
    fix: e.help,
    helpUrl: e.helpUrl,
  });

  let entries = [...BASELINE.byRule.values()];
  const ruleNeedle = filter.ruleId?.trim().toLowerCase();
  if (ruleNeedle !== undefined && ruleNeedle !== "") {
    entries = entries.filter((e) => e.ruleId.toLowerCase().includes(ruleNeedle));
  }
  const scNeedle = filter.sc?.trim();
  if (scNeedle !== undefined && scNeedle !== "") {
    entries = entries.filter((e) => e.sc.includes(scNeedle));
  }
  return entries.map(toInfo);
}
