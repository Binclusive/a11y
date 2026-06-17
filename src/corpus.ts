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
import { tierForOrgs } from "./distill/distill";
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
 * The evidence attached to a finding — a DISCRIMINATED UNION on `source`, so the
 * TYPE encodes which fields are meaningful for which source instead of the old
 * all-optional flat bag (where `tier`/`orgs`/`patterns` were nominally present
 * even when `source !== "audit"`). The three variants are non-overlapping
 * sources of truth that never mix:
 *
 *   - `"audit"`    — the SC has >= 1 distilled pattern (`data/corpus/patterns-*.json`).
 *                    The moat: truthful, partial (15 SCs). The GATE is presence
 *                    of a distilled pattern for the SC — NOT membership in the
 *                    hand-authored snapshot. The frequency `tier` is DERIVED:
 *                    `tierForOrgs(snapshot orgs)` for the 10 SCs the transitional
 *                    snapshot still covers (never the stale typed string), and
 *                    the strongest `frequencyTier` across the SC's patterns for
 *                    the 5 stranded SCs the snapshot lacks. `orgs` is the
 *                    transitional snapshot aggregate (number) for those 10 SCs,
 *                    else `null` for the 5 stranded ones. Carries the SC-generic
 *                    `fix` and the distilled `patterns`. `severity`/`helpUrl` are
 *                    the finding's runtime axe values, falling back to the
 *                    baseline catalog's published default for the matched SC —
 *                    they let the report show a severity and (for axe findings) a
 *                    `ref` even though the moat itself has no per-rule metadata.
 *   - `"baseline"` — no corpus match, but axe-core's baseline catalog
 *                    (`data/baseline-rules.json`) knows the rule. Coverage, NOT
 *                    audit-frequency data: carries axe's `severity` + standard
 *                    `fix` + `helpUrl`. Matched by the finding's SC, OR — for axe
 *                    best-practice rules that carry no WCAG SC tag (`region`,
 *                    `landmark-unique`, …) — by the axe ruleId, in which case
 *                    `sc` is null and `bestPractice` is true (`sc === null` ⇔
 *                    `bestPractice`). An axe recommendation must never be dressed
 *                    up with a fabricated SC.
 *   - `"none"`     — the finding's ruleId is genuinely absent from the catalog
 *                    (and no SC matched). It carries NO catalog evidence at all;
 *                    any severity/helpUrl to display comes off the finding's own
 *                    runtime axe metadata (read via {@link corpusSeverity} /
 *                    {@link corpusHelpUrl}), not off this variant.
 *
 * The axe-vs-SC DISPLAY policy ("for axe findings show the rule's own help, not
 * the SC-generic fix") lives in exactly one place — {@link resolveDisplay} — not
 * on this type and not in its consumers.
 */
export type CorpusEvidence =
  | {
      readonly source: "audit";
      readonly sc: string;
      readonly tier: CorpusTier;
      readonly orgs: number | null;
      readonly fix: string;
      readonly patterns: readonly DistilledPatternRef[];
      /**
       * The finding's runtime axe impact, else the baseline catalog's published
       * default for the matched SC, else null (a source-pass finding on an SC the
       * baseline catalog doesn't know). Display-only — the moat itself is
       * SC-level and carries no per-rule severity.
       */
      readonly severity: Severity | null;
      /**
       * The finding's runtime axe help URL (axe findings only), else the baseline
       * catalog's URL for the matched SC, else null. Display-only.
       */
      readonly helpUrl: string | null;
    }
  | {
      readonly source: "baseline";
      readonly sc: string | null;
      readonly severity: Severity;
      readonly fix: string;
      readonly helpUrl: string | null;
      /** `sc === null` ⇔ `bestPractice` — an axe rule with no WCAG SC tag. */
      readonly bestPractice: boolean;
    }
  | { readonly source: "none" };

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
 * TRANSITIONAL. The snapshot is loaded as `unknown` at the JSON boundary and
 * narrowed here, but `CRITERIA` no longer gates `source:"audit"` (the distilled
 * patterns do — see {@link buildScSummary}). It is parsed ONLY to supply, for
 * the 10 SCs it covers, the org INTEGER and the SC-generic `fix`. Its `tier`
 * field is NO LONGER READ: the SC-level tier is recomputed via `tierForOrgs`
 * from the org integer, so a stale hand-typed tier can never re-arm BUG 2.
 *
 * Values are validated structurally before use so a malformed snapshot fails
 * loud rather than smuggling `any` inward. (The `tier` field is still parsed for
 * back-compat / structural validation; it is simply ignored downstream.)
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

/** Tier strength ranking — lower rank = stronger (more widespread). */
const TIER_RANK: Record<CorpusTier, number> = {
  "very-common": 0,
  common: 1,
  occasional: 2,
  unknown: 3,
};

/** The strongest (most-widespread) tier across a list — min TIER_RANK wins. */
function maxTier(tiers: readonly CorpusTier[]): CorpusTier {
  // Only SCs with >= 1 pattern enter the summary, so the list is never empty;
  // the `occasional` seed is a defensive floor that the reduce never returns.
  return tiers.reduce<CorpusTier>(
    (best, t) => (TIER_RANK[t] < TIER_RANK[best] ? t : best),
    "occasional",
  );
}

/**
 * The DERIVED per-SC summary — the single source of truth for `source:"audit"`.
 * One entry per distilled SC (all 15), so the gate is "has a distilled pattern",
 * not snapshot membership. `tier` is DERIVED, never hand-typed:
 *
 *   - 10 SCs covered by the transitional snapshot → `tierForOrgs(orgs)` from the
 *     org INTEGER (auto-corrects the 5 mis-typed snapshot tiers; e.g. 1.1.1 with
 *     16 orgs becomes very-common), `orgs` = the snapshot integer.
 *   - 5 stranded SCs (1.3.5/1.4.3/2.4.6/2.4.7/3.2.5) → max `frequencyTier` across
 *     the SC's patterns, `orgs` = null (no snapshot org integer survives, and the
 *     distiller cannot re-run to recover one).
 *
 * `fix` is the SC-generic snapshot fix for covered SCs, else the strongest-tier
 * pattern's fix for stranded ones.
 */
interface ScSummaryEntry {
  readonly tier: CorpusTier;
  readonly orgs: number | null;
  readonly fix: string;
}

function buildScSummary(
  distilled: ReadonlyMap<string, DistilledPatternRef[]>,
  criteria: ReadonlyMap<string, CriterionEntry>,
): ReadonlyMap<string, ScSummaryEntry> {
  const map = new Map<string, ScSummaryEntry>();
  for (const sc of distilled.keys()) {
    const covered = criteria.get(sc);
    if (covered !== undefined) {
      // Derived from the org INTEGER — the BUG-2 fix. The snapshot's typed tier
      // is intentionally ignored.
      map.set(sc, {
        tier: tierForOrgs(covered.orgs),
        orgs: covered.orgs,
        fix: covered.fix,
      });
    } else {
      const refs = [...(distilled.get(sc) ?? [])].sort(
        // Strongest tier first; tie-break on id so `refs[0].fix` is deterministic
        // even if a stranded SC ever gains a second pattern at the same tier.
        (a, b) => TIER_RANK[a.frequencyTier] - TIER_RANK[b.frequencyTier] || a.id.localeCompare(b.id),
      );
      map.set(sc, {
        tier: maxTier(refs.map((r) => r.frequencyTier)),
        orgs: null,
        fix: refs[0]?.fix ?? "",
      });
    }
  }
  return map;
}

const SC_SUMMARY = buildScSummary(DISTILLED, CRITERIA);

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
  // GATE on the DERIVED per-SC summary (presence of a distilled pattern), not on
  // snapshot membership. A finding can carry several SC; pick the strongest one
  // present in the summary — by tier (strongest first), tie-broken by higher
  // orgs (org-less stranded SCs sort -1) then lowest SC string for determinism.
  let best: { sc: string; entry: ScSummaryEntry } | null = null;
  for (const sc of finding.wcag) {
    const entry = SC_SUMMARY.get(sc);
    if (entry === undefined) continue;
    if (best === null) {
      best = { sc, entry };
      continue;
    }
    const tierDelta = TIER_RANK[entry.tier] - TIER_RANK[best.entry.tier];
    const orgsDelta = (entry.orgs ?? -1) - (best.entry.orgs ?? -1);
    if (tierDelta < 0 || (tierDelta === 0 && orgsDelta > 0) || (tierDelta === 0 && orgsDelta === 0 && sc < best.sc)) {
      best = { sc, entry };
    }
  }

  // 1. AUDIT — the real-frequency moat. Severity/helpUrl are display-only: the
  //    finding's own runtime axe values when present, else the baseline catalog's
  //    published default for the matched SC.
  if (best !== null) {
    const baseline = BASELINE.bySc.get(best.sc);
    return withCorpus(finding, {
      source: "audit",
      sc: best.sc,
      tier: best.entry.tier,
      orgs: best.entry.orgs,
      fix: best.entry.fix,
      patterns: DISTILLED.get(best.sc) ?? [],
      severity: finding.severity ?? baseline?.severity ?? null,
      helpUrl: finding.helpUrl ?? baseline?.helpUrl ?? null,
    });
  }

  // 2. BASELINE by SC — coverage for WCAG SCs the corpus has never distilled.
  //    Runtime axe impact (most accurate) wins over the catalog default.
  const bySc = baselineBySc(finding);
  if (bySc !== null) {
    return withCorpus(finding, {
      source: "baseline",
      sc: bySc.sc,
      fix: bySc.entry.help,
      severity: finding.severity ?? bySc.entry.severity,
      helpUrl: finding.helpUrl ?? bySc.entry.helpUrl,
      bestPractice: false,
    });
  }

  // 3. BASELINE by ruleId — axe best-practice rules with NO WCAG SC tag. The
  //    catalog knows the rule even though `bySc` missed; report it honestly with
  //    `sc: null` + `bestPractice: true` rather than dropping to UNMAPPED. (A
  //    catalog rule WITH an SC would have matched by SC above.)
  const byRule = BASELINE.byRule.get(finding.ruleId);
  if (byRule !== undefined) {
    return withCorpus(finding, {
      source: "baseline",
      sc: byRule.sc[0] ?? null,
      fix: byRule.help,
      severity: finding.severity ?? byRule.severity,
      helpUrl: finding.helpUrl ?? byRule.helpUrl,
      bestPractice: byRule.sc.length === 0,
    });
  }

  // 4. NONE — the ruleId is absent from the catalog and no SC matched. No
  //    catalog evidence; any displayable severity/helpUrl comes off the finding.
  return withCorpus(finding, { source: "none" });
}

/** Attach a corpus-evidence variant to a finding. The one place the two join. */
function withCorpus(finding: Finding, corpus: CorpusEvidence): EnrichedFinding {
  return { ...finding, corpus };
}

/** Enrich a batch of findings. */
export function enrichAll(findings: readonly Finding[]): EnrichedFinding[] {
  return findings.map(enrich);
}

/** The frequency tier as a flat value across the union — `unknown` off-moat. */
export function corpusTier(c: CorpusEvidence): CorpusTier {
  return c.source === "audit" ? c.tier : "unknown";
}

/** The SC-keyed corpus fix where one exists (audit/baseline), else null. */
export function corpusFix(c: CorpusEvidence): string | null {
  switch (c.source) {
    case "audit":
    case "baseline":
      return c.fix;
    case "none":
      return null;
  }
}

/**
 * The severity to display for a finding: the catalog/runtime value the variant
 * carries, falling back to the finding's own runtime axe impact for `none`.
 */
export function corpusSeverity(f: EnrichedFinding): Severity | null {
  const c = f.corpus;
  switch (c.source) {
    case "audit":
    case "baseline":
      return c.severity;
    case "none":
      return f.severity ?? null;
  }
}

/**
 * The Deque help URL to display for a finding: the catalog/runtime value the
 * variant carries, falling back to the finding's own runtime URL for `none`.
 */
export function corpusHelpUrl(f: EnrichedFinding): string | null {
  const c = f.corpus;
  switch (c.source) {
    case "audit":
    case "baseline":
      return c.helpUrl;
    case "none":
      return f.helpUrl ?? null;
  }
}

/** Whether this is an axe best-practice recommendation (no WCAG SC). */
export function corpusBestPractice(c: CorpusEvidence): boolean {
  return c.source === "baseline" && c.bestPractice;
}

/**
 * The resolved DISPLAY contract for a finding — the SOLE owner of the axe-vs-SC
 * policy. Every consumer (the CLI `detailLines` printer, the MCP `CheckFinding`)
 * reads this instead of re-deriving the policy, so they can never disagree.
 *
 * The policy: for a `provenance === "axe"` (rendered-DOM) finding the corpus
 * `fix` is SC-GENERIC — written for the SC's most-common failure (1.1.1 →
 * missing image alt) — but one SC spans many axe rules with different failure
 * modes (`aria-progressbar-name` is also 1.1.1), so that fix contradicts the
 * rule. axe's OWN per-rule guidance is rule-accurate, so for axe findings we
 * show the rule's help/`ref` and suppress both the SC-generic `fix:` line and
 * the distilled `seen-in-the-wild` patterns (equally SC-generic). For source
 * findings (`jsx-a11y` / `enforce`) the rule↔SC mapping is clean via wcag-map,
 * so the corpus `fix` + patterns are rule-accurate and shown verbatim.
 */
export interface DisplayContract {
  /** Uppercased severity for the `severity:` line, or null to omit it. */
  readonly severityLabel: string | null;
  /** Text for the CLI `fix:` line, or null to suppress it (axe → suppressed). */
  readonly fixLine: string | null;
  /**
   * The rule-accurate fix string for API emission (MCP `CheckFinding.fix`): axe
   * findings get axe's per-rule help (`message`); source findings get the corpus
   * `fix`. Unlike `fixLine` this is never suppressed — the MCP field always
   * carries the rule-accurate fix; the CLI just renders axe's via `ref` instead.
   */
  readonly fix: string | null;
  /** The Deque help URL to render as a `ref:` line, or null to omit it. */
  readonly refUrl: string | null;
  /** Whether to render the distilled `seen-in-the-wild` patterns block. */
  readonly showPatterns: boolean;
}

export function resolveDisplay(f: EnrichedFinding): DisplayContract {
  const c = f.corpus;
  const isAxe = f.provenance === "axe";
  const severity = corpusSeverity(f);
  // axe → rule-accurate help (its own message); source → SC-keyed corpus fix.
  const ruleFix = isAxe ? (f.message ?? null) : corpusFix(c);
  // The CLI `fix:` line is suppressed ONLY for an AUDIT axe finding: there the
  // corpus fix is SC-generic and contradicts the rule, so the rule's `ref`
  // stands in. A BASELINE fix is already axe's per-rule help (rule-accurate), so
  // it is shown for axe and source alike; `none` never carries a fix line.
  const fixLine = c.source === "audit" ? (isAxe ? null : c.fix) : corpusFix(c);
  // `ref:` shows for every axe finding, and for every baseline/none finding that
  // carries a help URL; an audit SOURCE finding shows its corpus fix, not a ref.
  const refUrl = isAxe || c.source !== "audit" ? corpusHelpUrl(f) : null;
  return {
    severityLabel: severity === null ? null : severity.toUpperCase(),
    fixLine,
    fix: ruleFix,
    refUrl,
    showPatterns: !isAxe && c.source === "audit" && c.patterns.length > 0,
  };
}

/** A corpus SC entry surfaced for contract generation: SC + frequency + fix. */
export interface CorpusCriterion {
  readonly sc: string;
  readonly orgs: number | null;
  readonly tier: CorpusTier;
  readonly fix: string;
}

/**
 * Every distilled corpus SC (all 15), ordered most-widespread first. This is the
 * source of truth the contract layer reads from: enforcement defaults split on
 * the DERIVED `tier`, and the AGENTS.md block leads with the top SC. `orgs` is
 * null for the 5 stranded SCs the snapshot never covered. Pure data — no finding
 * required.
 */
export function corpusCriteria(): readonly CorpusCriterion[] {
  return [...SC_SUMMARY.entries()]
    .map(([sc, e]) => ({ sc, orgs: e.orgs, tier: e.tier, fix: e.fix }))
    .sort((a, b) => {
      const t = TIER_RANK[a.tier] - TIER_RANK[b.tier];
      if (t !== 0) return t;
      const o = (b.orgs ?? -1) - (a.orgs ?? -1);
      if (o !== 0) return o;
      return a.sc < b.sc ? -1 : a.sc > b.sc ? 1 : 0;
    });
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

/**
 * Every distilled pattern, deduped by id and ordered by frequency tier
 * (very-common → common → occasional) then SC then id for a stable diff.
 *
 * A pattern can appear under several SC in `DISTILLED` (it's keyed per-SC); we
 * attach the SC under which it is most widespread — same "lead with the
 * highest-impact framing" rule `enrich` uses — and carry that SC's aggregate
 * org count from the snapshot. Pure data; the AGENTS.md generator reads this.
 */
let CORPUS_PATTERNS: readonly CorpusPattern[] | undefined;

export function corpusPatterns(): readonly CorpusPattern[] {
  // Memoized: `DISTILLED` is immutable JSON, so the dedup+sort runs once and the
  // frozen result is shared (hot path — `retrieveSlice` calls this every review).
  return (CORPUS_PATTERNS ??= Object.freeze(computeCorpusPatterns()));
}

function computeCorpusPatterns(): CorpusPattern[] {
  // Pick the most-widespread SC per pattern id (most orgs; tie → lowest SC).
  const bySc = new Map<string, { ref: DistilledPatternRef; sc: string; orgs: number | null }>();
  for (const [sc, refs] of DISTILLED.entries()) {
    const orgs = SC_SUMMARY.get(sc)?.orgs ?? null;
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
 * The journey tags for each distilled pattern, keyed by pattern id. RETRIEVAL-
 * INTERNAL: journey hints (`checkout`, `sign-in`, `search`, …) drive the
 * corpus-slice retriever's path→tag boost (RFC Phase 1, R3) but are NOT part of
 * the public {@link CorpusPattern} display shape — a pattern surfaces the same
 * regardless of which journey pulled it in. Deduped by id, same as
 * {@link corpusPatterns}; a pattern with no tags maps to an empty array.
 */
let CORPUS_JOURNEY_TAGS: ReadonlyMap<string, readonly string[]> | undefined;

export function corpusJourneyTags(): ReadonlyMap<string, readonly string[]> {
  // Memoized over the immutable `DISTILLED` map (hot path — `retrieveSlice` reads
  // it every review). The shared Map is read-only by its `ReadonlyMap` type.
  return (CORPUS_JOURNEY_TAGS ??= computeCorpusJourneyTags());
}

function computeCorpusJourneyTags(): ReadonlyMap<string, readonly string[]> {
  const map = new Map<string, readonly string[]>();
  for (const refs of DISTILLED.values()) {
    for (const ref of refs) {
      if (!map.has(ref.id)) map.set(ref.id, ref.journeyTags);
    }
  }
  return map;
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
