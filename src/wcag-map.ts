/**
 * jsx-a11y rule id -> WCAG Success Criteria.
 *
 * The map is the bridge between the lint engine's vocabulary (rule ids) and
 * Binclusive's audit vocabulary (WCAG SC numbers). The corpus cross-ref
 * (see `corpus.ts`) keys off the SC, so this map is what lets a source-level
 * lint hit inherit real-world frequency from the dynamic-audit corpus.
 *
 * Rule ids are unprefixed here; the engine emits them prefixed as
 * `jsx-a11y/<id>`. `wcagForRuleId` strips the prefix before lookup.
 */
export const RULE_ID_TO_WCAG: Readonly<Record<string, readonly string[]>> = {
  "label-has-associated-control": ["1.3.1", "4.1.2"],
  "alt-text": ["1.1.1"],
  "anchor-has-content": ["2.4.4"],
  "anchor-is-valid": ["2.4.4"],
  "aria-props": ["4.1.2"],
  "role-has-required-aria-props": ["4.1.2"],
  "role-supports-aria-props": ["4.1.2"],
  "interactive-supports-focus": ["2.1.1"],
  "click-events-have-key-events": ["2.1.1"],
  "no-static-element-interactions": ["2.1.1"],
  "heading-has-content": ["1.3.1"],
};

/**
 * Look up the WCAG SC for a (possibly `jsx-a11y/`-prefixed) rule id.
 * Returns `[]` for rules we have not mapped — the finding still reports,
 * it just carries no SC and therefore no corpus enrichment.
 */
export function wcagForRuleId(ruleId: string | null): readonly string[] {
  if (ruleId === null) return [];
  const bare = ruleId.startsWith("jsx-a11y/") ? ruleId.slice("jsx-a11y/".length) : ruleId;
  return RULE_ID_TO_WCAG[bare] ?? [];
}
