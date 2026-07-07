/**
 * Impact-first message voice (#14).
 *
 * Every finding a11y-checker surfaces leads with one consistent shape:
 *
 *   [who is affected] can't [do what] because [cause], so [fix].
 *
 * The lead names the harmed user and the human consequence — the first thing a
 * reader sees — rather than a rule id or SC number. The rule id, WCAG SC, and
 * corpus "seen-in-the-wild" frequency stay, but as SECONDARY lines the report
 * renders separately (see `cli.ts` `detailLines`), never inline in the sentence.
 *
 * The enforce content rules (`enforce.ts`) author their own messages in this
 * shape. The jsx-a11y structural pass does NOT — its findings come straight from
 * eslint-plugin-jsx-a11y, whose upstream messages lead with the rule requirement
 * ("Buttons must have discernible text"), not the impacted user. This module is
 * the wrapper that rewrites those upstream messages into the same impact-first
 * voice, keyed by jsx-a11y rule id. It covers exactly the rules we score
 * (`core.ts` `SCORED_RULES`); any rule not mapped here falls back to its upstream
 * message unchanged, so the remap can only improve voice, never blank a finding.
 *
 * This is a display-only rewrite: it changes the `message` string, nothing about
 * detection, the rule id, the WCAG mapping, the corpus enrichment, or the matrix
 * baseline (which records file/line/ruleId, not message text).
 */

/**
 * Impact-first messages for the jsx-a11y rules we score. Keyed by the bare rule
 * name (no `jsx-a11y/` prefix) — the caller strips the namespace before lookup.
 * Each follows the [who] can't [do what] because [cause], so [fix] template.
 */
const JSX_A11Y_IMPACT_MESSAGES: Readonly<Record<string, string>> = {
  "label-has-associated-control":
    "Screen-reader users can't tell what to enter in this field because its control has no associated <label>, so pair the control with a <label> (htmlFor + id, or wrap it) and the field will be announced.",
  "alt-text":
    'Blind users can\'t perceive this image because it has no alt text, so add an alt that conveys its meaning, or alt="" if it is purely decorative.',
  "anchor-has-content":
    "Screen-reader users can't tell where this link goes because it has no discernible content, so give the anchor visible text or an aria-label that names its destination.",
  "anchor-is-valid":
    "Keyboard and screen-reader users can't reliably follow this link because it has no valid href, so give it a real href — or use a <button> if it triggers an action rather than navigating.",
  "aria-props":
    "Assistive tech can't interpret this element because it carries an attribute that isn't a valid aria-* property, so remove or correct the invalid ARIA attribute.",
  "role-has-required-aria-props":
    "Screen-reader users can't fully operate this control because its role is missing ARIA properties that role requires, so add the required aria-* attributes for the role.",
  "role-supports-aria-props":
    "Screen-reader users can't rely on this element because it has an aria-* attribute its role doesn't support, so remove the unsupported attribute or change the role.",
  "interactive-supports-focus":
    "Keyboard users can't reach this control because it is interactive but not focusable, so make it focusable (use a native control, or add tabIndex) and it can be operated without a mouse.",
  "click-events-have-key-events":
    "Keyboard users can't activate this element because it has a click handler but no keyboard handler, so add a key handler — or use a <button> — and it will work without a mouse.",
  "no-static-element-interactions":
    "Keyboard and screen-reader users can't operate this element because a click handler sits on a non-interactive element with no role, so use a native control, or add an interactive role plus keyboard support.",
  "heading-has-content":
    "Screen-reader users can't navigate by this heading because it has no text content, so give the heading discernible text (or remove it if it is not really a heading).",
};

/**
 * Rewrite a jsx-a11y finding's upstream eslint message into the impact-first
 * voice. `ruleId` is the full id (`jsx-a11y/alt-text`); `fallback` is the
 * upstream message used verbatim when the rule isn't in the map — so a finding
 * always carries a message, and an unmapped rule degrades to its original text.
 */
export function impactFirstJsxA11yMessage(ruleId: string, fallback: string): string {
  const bare = ruleId.startsWith("jsx-a11y/") ? ruleId.slice("jsx-a11y/".length) : ruleId;
  return JSX_A11Y_IMPACT_MESSAGES[bare] ?? fallback;
}
