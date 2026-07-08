import baselineCatalog from "../data/baseline-rules.json" with { type: "json" };
import type { AxeImpact, Finding } from "./core";

export type { AxeImpact };

/**
 * The evidence attached to a finding — a DISCRIMINATED UNION on `source`. The
 * engine is pure detection: it cross-references a finding against the coverage
 * catalog (axe-core's published per-rule metadata) and nothing else. Audit
 * frequency is platform-derived (ADR 0041 §G — the corpus left the engine), so
 * there is no `audit` variant and no finding carries a frequency `tier`.
 *
 *   - `"baseline"` — axe-core's baseline catalog (`data/baseline-rules.json`)
 *                    knows the rule. Coverage, NOT audit-frequency data: carries
 *                    axe's `impact` + standard `fix` + `helpUrl`. Matched by the
 *                    finding's SC, OR — for axe best-practice rules that carry no
 *                    WCAG SC tag (`region`, `landmark-unique`, …) — by the axe
 *                    ruleId, in which case `sc` is null and `bestPractice` is true
 *                    (`sc === null` ⇔ `bestPractice`). An axe recommendation must
 *                    never be dressed up with a fabricated SC.
 *   - `"none"`     — the finding's ruleId is genuinely absent from the catalog
 *                    (and no SC matched). It carries NO catalog evidence at all;
 *                    any impact/helpUrl to display comes off the finding's own
 *                    runtime axe metadata (read via {@link evidenceImpact} /
 *                    {@link evidenceHelpUrl}), not off this variant.
 *
 * The axe-vs-SC DISPLAY policy ("for axe findings show the rule's own help, not
 * the SC-generic fix") lives in exactly one place — {@link resolveDisplay} — not
 * on this type and not in its consumers.
 */
export type Evidence =
  | {
      readonly source: "baseline";
      readonly sc: string | null;
      readonly impact: AxeImpact;
      readonly fix: string;
      readonly helpUrl: string | null;
      /** `sc === null` ⇔ `bestPractice` — an axe rule with no WCAG SC tag. */
      readonly bestPractice: boolean;
    }
  | { readonly source: "none" };

/** A finding plus its coverage-catalog cross-reference. */
export interface EnrichedFinding extends Finding {
  readonly corpus: Evidence;
}

/**
 * A baseline-catalog rule, narrowed from `data/baseline-rules.json`. Mirrors the
 * generator's `BaselineRule` shape. This is the COVERAGE source of truth (axe's
 * published per-rule metadata); it never carries an org count or a frequency tier.
 */
interface BaselineRuleEntry {
  readonly ruleId: string;
  readonly sc: readonly string[];
  readonly impact: AxeImpact;
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
  const isImpact = (s: unknown): s is AxeImpact =>
    s === "minor" || s === "moderate" || s === "serious" || s === "critical";

  if (typeof raw !== "object" || raw === null || !("rules" in raw)) return { byRule, bySc };
  const list = (raw as { rules: unknown }).rules;
  if (!Array.isArray(list)) return { byRule, bySc };

  for (const r of list) {
    if (typeof r !== "object" || r === null) continue;
    const { ruleId, sc, impact, help, helpUrl } = r as Record<string, unknown>;
    if (
      typeof ruleId !== "string" ||
      !Array.isArray(sc) ||
      !isImpact(impact) ||
      typeof help !== "string" ||
      typeof helpUrl !== "string"
    ) {
      continue;
    }
    const scList = sc.filter((s): s is string => typeof s === "string");
    const entry: BaselineRuleEntry = { ruleId, sc: scList, impact, help, helpUrl };
    byRule.set(ruleId, entry);
    for (const oneSc of scList) {
      if (!bySc.has(oneSc)) bySc.set(oneSc, entry);
    }
  }
  return { byRule, bySc };
}

const BASELINE = readBaseline(baselineCatalog);

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
 * Cross-reference a finding against the coverage catalog, most-authoritative
 * first, so every finding surfaces with an impact and a fix instead of
 * dead-ending at null:
 *
 *   1. BASELINE (by SC) — coverage for the finding's WCAG SCs. axe's published
 *      per-rule impact + standard fix + helpUrl. → `source: "baseline"`,
 *      `bestPractice: false`.
 *   2. BASELINE (by ruleId) — the axe best-practice rules that carry NO WCAG SC
 *      tag (`region`, `landmark-unique`, …). Matched by the finding's axe ruleId,
 *      reported honestly: `sc: null`, `bestPractice: true`, still carrying
 *      impact + fix + helpUrl. → `source: "baseline"`.
 *   3. NONE — the ruleId is genuinely absent from the catalog (and no SC
 *      matched). An axe finding may still surface its own runtime impact/helpUrl.
 *
 * For axe findings the runtime impact already on the finding always wins over
 * the catalog's static impact.
 */
export function enrich(finding: Finding): EnrichedFinding {
  // 1. BASELINE by SC — coverage for the finding's WCAG SCs. Runtime axe impact
  //    (most accurate) wins over the catalog default.
  const bySc = baselineBySc(finding);
  if (bySc !== null) {
    return withEvidence(finding, {
      source: "baseline",
      sc: bySc.sc,
      fix: bySc.entry.help,
      impact: finding.impact ?? bySc.entry.impact,
      helpUrl: finding.helpUrl ?? bySc.entry.helpUrl,
      bestPractice: false,
    });
  }

  // 2. BASELINE by ruleId — axe best-practice rules with NO WCAG SC tag. The
  //    catalog knows the rule even though `bySc` missed; report it honestly with
  //    `sc: null` + `bestPractice: true` rather than dropping to NONE. (A catalog
  //    rule WITH an SC would have matched by SC above.)
  const byRule = BASELINE.byRule.get(finding.ruleId);
  if (byRule !== undefined) {
    return withEvidence(finding, {
      source: "baseline",
      sc: byRule.sc[0] ?? null,
      fix: byRule.help,
      impact: finding.impact ?? byRule.impact,
      helpUrl: finding.helpUrl ?? byRule.helpUrl,
      bestPractice: byRule.sc.length === 0,
    });
  }

  // 3. NONE — the ruleId is absent from the catalog and no SC matched. No catalog
  //    evidence; any displayable impact/helpUrl comes off the finding.
  return withEvidence(finding, { source: "none" });
}

/** Attach an evidence variant to a finding. The one place the two join. */
function withEvidence(finding: Finding, evidence: Evidence): EnrichedFinding {
  return { ...finding, corpus: evidence };
}

/** Enrich a batch of findings. */
export function enrichAll(findings: readonly Finding[]): EnrichedFinding[] {
  return findings.map(enrich);
}

/** The SC-keyed fix where one exists (baseline), else null. */
export function evidenceFix(c: Evidence): string | null {
  switch (c.source) {
    case "baseline":
      return c.fix;
    case "none":
      return null;
  }
}

/**
 * The impact to display for a finding: the catalog/runtime value the variant
 * carries, falling back to the finding's own runtime axe impact for `none`.
 */
export function evidenceImpact(f: EnrichedFinding): AxeImpact | null {
  const c = f.corpus;
  switch (c.source) {
    case "baseline":
      return c.impact;
    case "none":
      return f.impact ?? null;
  }
}

/**
 * The Deque help URL to display for a finding: the catalog/runtime value the
 * variant carries, falling back to the finding's own runtime URL for `none`.
 */
export function evidenceHelpUrl(f: EnrichedFinding): string | null {
  const c = f.corpus;
  switch (c.source) {
    case "baseline":
      return c.helpUrl;
    case "none":
      return f.helpUrl ?? null;
  }
}

/** Whether this is an axe best-practice recommendation (no WCAG SC). */
export function evidenceBestPractice(c: Evidence): boolean {
  return c.source === "baseline" && c.bestPractice;
}

/**
 * The resolved DISPLAY contract for a finding — the SOLE owner of the axe-vs-SC
 * policy. Every consumer (the CLI `detailLines` printer, the MCP `CheckFinding`)
 * reads this instead of re-deriving the policy, so they can never disagree.
 *
 * The policy: an axe (rendered-DOM) finding shows its own per-rule help
 * (`message`) and runtime `ref`. A source finding (`jsx-a11y` / `enforce`) shows
 * the fix + `ref` of its OWN deque rule, resolved by rule id through
 * {@link SOURCE_RULE_TO_AXE} — never the SC-first grab, which cross-wired an
 * unrelated deque rule onto both surfaces (#192). Impact is left as `enrich`
 * resolved it; this contract corrects only the fix/ref association.
 */
export interface DisplayContract {
  /** Uppercased impact for the `impact:` line, or null to omit it. */
  readonly impactLabel: string | null;
  /** Text for the CLI `fix:` line, or null to suppress it. */
  readonly fixLine: string | null;
  /**
   * The rule-accurate fix string for API emission (MCP `CheckFinding.fix`): axe
   * findings get axe's per-rule help (`message`); source findings get their OWN
   * deque rule's fix (see {@link SOURCE_RULE_TO_AXE}). Unlike `fixLine` this is
   * never suppressed.
   */
  readonly fix: string | null;
  /** The Deque help URL to render as a `ref:` line, or null to omit it. */
  readonly refUrl: string | null;
}

/**
 * A source rule's OWN deque rule — the axe rule whose Deque doc describes the
 * SAME failure the source rule detects. This is the finding-to-ref association
 * keyed by the finding's own rule id, the fix for #192: previously a source
 * finding's fix-prose + deque ref were pulled off {@link baselineBySc}, which
 * returns the FIRST axe rule (in ruleId-sorted catalog order) that happens to
 * tag the finding's SC — an unrelated rule. So `jsx-a11y/alt-text` (SC 1.1.1)
 * got `aria-meter-name` (the alphabetically-first 1.1.1 rule), and
 * `enforce/dialog-no-name` got `area-alt` — a systematic mis-key that corrupted
 * BOTH the report `fix:`/`ref:` lines and the SARIF `helpUri`. An SC maps to
 * many axe rules, so SC alone can never name the RIGHT one; the correspondent is
 * declared here per rule instead. A rule with no clean single axe correspondent
 * is intentionally absent — it then shows no deque ref rather than a wrong one.
 */
const SOURCE_RULE_TO_AXE: Readonly<Record<string, string>> = {
  "jsx-a11y/alt-text": "image-alt",
  "jsx-a11y/anchor-has-content": "link-name",
  "jsx-a11y/label-has-associated-control": "label",
  "jsx-a11y/heading-has-content": "empty-heading",
  "jsx-a11y/aria-props": "aria-valid-attr-value",
  "jsx-a11y/role-has-required-aria-props": "aria-required-attr",
  "jsx-a11y/role-supports-aria-props": "aria-allowed-attr",
  "enforce/button-no-name": "button-name",
  "enforce/image-no-alt": "image-alt",
  "enforce/link-no-name": "link-name",
  "enforce/dialog-no-name": "aria-dialog-name",
  "enforce/input-no-name": "label",
};

/**
 * The baseline catalog entry for a SOURCE finding's own deque rule, or null when
 * the rule has no declared correspondent (→ no cross-wired ref is shown). Keyed
 * by the finding's own rule id, never by a shared SC. See {@link SOURCE_RULE_TO_AXE}.
 */
function dequeRuleFor(f: EnrichedFinding): BaselineRuleEntry | null {
  const axeId = SOURCE_RULE_TO_AXE[f.ruleId];
  if (axeId === undefined) return null;
  return BASELINE.byRule.get(axeId) ?? null;
}

export function resolveDisplay(f: EnrichedFinding): DisplayContract {
  const isAxe = f.provenance === "axe";
  // Impact stays exactly as `enrich` resolved it — #192 corrects only the
  // fix-prose → deque-ref association, never the impact / SC / rule id.
  const impact = evidenceImpact(f);
  // The deque rule to cite is the one describing THIS finding's own failure: an
  // axe finding carries its own runtime help/url; a source finding resolves its
  // own declared axe correspondent — NOT the SC-first grab that cross-wired an
  // unrelated deque rule onto both the `fix:` line and the SARIF `helpUri` (#192).
  const deque = isAxe ? null : dequeRuleFor(f);
  const ruleFix = isAxe ? (f.message ?? null) : (deque?.help ?? null);
  const fixLine = isAxe ? evidenceFix(f.corpus) : (deque?.help ?? null);
  const refUrl = isAxe ? evidenceHelpUrl(f) : (deque?.helpUrl ?? null);
  return {
    impactLabel: impact === null ? null : impact.toUpperCase(),
    fixLine,
    fix: ruleFix,
    refUrl,
  };
}

/**
 * A baseline-catalog rule surfaced for `get_a11y_rules`: axe's published
 * per-rule data (ruleId, SC, impact, standard fix, helpUrl) for ANY axe/WCAG
 * rule. Carries NO org count and NO frequency tier (it is not audit data).
 */
export interface BaselineRuleInfo {
  readonly ruleId: string;
  readonly sc: readonly string[];
  readonly impact: AxeImpact;
  readonly fix: string;
  readonly helpUrl: string;
}

/**
 * Look up baseline rules by axe ruleId substring and/or WCAG SC. With no filter,
 * returns the whole catalog (already ruleId-sorted, deterministic). Pure read
 * over `baseline-rules.json`.
 */
export function baselineRules(filter: { ruleId?: string; sc?: string } = {}): BaselineRuleInfo[] {
  const toInfo = (e: BaselineRuleEntry): BaselineRuleInfo => ({
    ruleId: e.ruleId,
    sc: e.sc,
    impact: e.impact,
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
