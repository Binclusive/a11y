import baselineCatalog from "../data/baseline-rules.json" with { type: "json" };
import type { Finding } from "./core";

/** Severity levels, ordered least → most severe. axe's runtime impact vocabulary. */
export type Severity = "minor" | "moderate" | "serious" | "critical";

/**
 * The evidence attached to a finding — a DISCRIMINATED UNION on `source`. The
 * engine is pure detection: it cross-references a finding against the coverage
 * catalog (axe-core's published per-rule metadata) and nothing else. Audit
 * frequency is platform-derived (ADR 0041 §G — the corpus left the engine), so
 * there is no `audit` variant and no finding carries a frequency `tier`.
 *
 *   - `"baseline"` — axe-core's baseline catalog (`data/baseline-rules.json`)
 *                    knows the rule. Coverage, NOT audit-frequency data: carries
 *                    axe's `severity` + standard `fix` + `helpUrl`. Matched by the
 *                    finding's SC, OR — for axe best-practice rules that carry no
 *                    WCAG SC tag (`region`, `landmark-unique`, …) — by the axe
 *                    ruleId, in which case `sc` is null and `bestPractice` is true
 *                    (`sc === null` ⇔ `bestPractice`). An axe recommendation must
 *                    never be dressed up with a fabricated SC.
 *   - `"none"`     — the finding's ruleId is genuinely absent from the catalog
 *                    (and no SC matched). It carries NO catalog evidence at all;
 *                    any severity/helpUrl to display comes off the finding's own
 *                    runtime axe metadata (read via {@link evidenceSeverity} /
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
      readonly severity: Severity;
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
 * first, so every finding surfaces with a severity and a fix instead of
 * dead-ending at null:
 *
 *   1. BASELINE (by SC) — coverage for the finding's WCAG SCs. axe's published
 *      per-rule severity + standard fix + helpUrl. → `source: "baseline"`,
 *      `bestPractice: false`.
 *   2. BASELINE (by ruleId) — the axe best-practice rules that carry NO WCAG SC
 *      tag (`region`, `landmark-unique`, …). Matched by the finding's axe ruleId,
 *      reported honestly: `sc: null`, `bestPractice: true`, still carrying
 *      severity + fix + helpUrl. → `source: "baseline"`.
 *   3. NONE — the ruleId is genuinely absent from the catalog (and no SC
 *      matched). An axe finding may still surface its own runtime severity/helpUrl.
 *
 * For axe findings the runtime impact already on the finding always wins over
 * the catalog's static severity.
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
      severity: finding.severity ?? bySc.entry.severity,
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
      severity: finding.severity ?? byRule.severity,
      helpUrl: finding.helpUrl ?? byRule.helpUrl,
      bestPractice: byRule.sc.length === 0,
    });
  }

  // 3. NONE — the ruleId is absent from the catalog and no SC matched. No catalog
  //    evidence; any displayable severity/helpUrl comes off the finding.
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
 * The severity to display for a finding: the catalog/runtime value the variant
 * carries, falling back to the finding's own runtime axe impact for `none`.
 */
export function evidenceSeverity(f: EnrichedFinding): Severity | null {
  const c = f.corpus;
  switch (c.source) {
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
 * The policy: for a `provenance === "axe"` (rendered-DOM) finding the baseline
 * `fix` is SC-GENERIC, so for axe findings we show the rule's own per-rule help
 * (`message`)/`ref` instead. For source findings (`jsx-a11y` / `enforce`) the
 * rule↔SC mapping is clean via wcag-map, so the baseline `fix` is rule-accurate
 * and shown verbatim.
 */
export interface DisplayContract {
  /** Uppercased severity for the `severity:` line, or null to omit it. */
  readonly severityLabel: string | null;
  /** Text for the CLI `fix:` line, or null to suppress it. */
  readonly fixLine: string | null;
  /**
   * The rule-accurate fix string for API emission (MCP `CheckFinding.fix`): axe
   * findings get axe's per-rule help (`message`); source findings get the
   * baseline `fix`. Unlike `fixLine` this is never suppressed.
   */
  readonly fix: string | null;
  /** The Deque help URL to render as a `ref:` line, or null to omit it. */
  readonly refUrl: string | null;
}

export function resolveDisplay(f: EnrichedFinding): DisplayContract {
  const c = f.corpus;
  const isAxe = f.provenance === "axe";
  const severity = evidenceSeverity(f);
  // axe → rule-accurate help (its own message); source → SC-keyed baseline fix.
  const ruleFix = isAxe ? (f.message ?? null) : evidenceFix(c);
  // A baseline fix is axe's per-rule help (rule-accurate), so it is shown for axe
  // and source alike; `none` never carries a fix line.
  const fixLine = evidenceFix(c);
  // `ref:` shows for every axe finding, and for every finding carrying a help URL.
  const refUrl = evidenceHelpUrl(f);
  return {
    severityLabel: severity === null ? null : severity.toUpperCase(),
    fixLine,
    fix: ruleFix,
    refUrl,
  };
}

/**
 * A baseline-catalog rule surfaced for `get_a11y_rules`: axe's published
 * per-rule data (ruleId, SC, severity, standard fix, helpUrl) for ANY axe/WCAG
 * rule. Carries NO org count and NO frequency tier (it is not audit data).
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
 * returns the whole catalog (already ruleId-sorted, deterministic). Pure read
 * over `baseline-rules.json`.
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
