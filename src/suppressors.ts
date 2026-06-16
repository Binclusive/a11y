import ts from "typescript";

/**
 * The static floor's shared SUPPRESSOR predicates.
 *
 * Per ADR 0003 ("A Deterministic Shell Around Every Stochastic Capability"),
 * the static floor's suppressors live in their own module so a later phase can
 * reuse them, unchanged, as a precision PRE-FILTER on a corpus-grounded recall
 * layer. Each predicate answers a single "uncertain → skip" question about one
 * JSX element (is its `type` exempt? is it hidden? is it a label/name-injecting
 * container?), built on the small name-reading primitives below
 * ({@link attrState}, {@link anyNameAttr}). Keep these FN-safe and side-effect
 * free: a recall layer composes them, so any behavior drift here ripples.
 */

/** Native `<input>` `type` values that exempt it from the name check. submit /
 * button / reset are named by their `value`; hidden / image are not text-name-
 * bearing (an image input's name is alt's job); checkbox / radio are externally
 * labelled toggles, skipped exactly as {@link TOGGLE_NAMES} are. A DYNAMIC
 * `type={x}` is unknowable, so — uncertain → skip — it is exempt too. A MISSING
 * `type` defaults to `"text"` and is NOT exempt: a bare text input must be named.
 */
const NAME_EXEMPT_INPUT_TYPES: ReadonlySet<string> = new Set([
  "hidden",
  "submit",
  "button",
  "reset",
  "image",
  "checkbox",
  "radio",
]);

/** The accessible-name attributes that, if present/dynamic, satisfy a control. */
export const LABEL_ATTRS = ["aria-label", "aria-labelledby"] as const;

/**
 * Whether `attr` is present AND carries a NON-EMPTY value we can read statically.
 * A dynamic expression (`aria-label={x}`) counts as present-and-unknowable, so
 * we treat it as "could be a name" — conservatism: never flag when uncertain.
 * Returns `"missing" | "present" | "dynamic"`.
 */
export type AttrState = "missing" | "present" | "dynamic";

export function attrState(
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  sf: ts.SourceFile,
  attrName: string,
): AttrState {
  for (const attr of opening.attributes.properties) {
    if (!ts.isJsxAttribute(attr)) continue;
    if (attr.name.getText(sf) !== attrName) continue;
    const init = attr.initializer;
    // Bare attribute (`hidden`) — present, treated as a (truthy) value.
    if (init === undefined) return "present";
    if (ts.isStringLiteral(init)) return init.text.trim() === "" ? "missing" : "present";
    if (ts.isJsxExpression(init)) {
      const expr = init.expression;
      if (expr === undefined) return "missing"; // `aria-label={}`
      if (ts.isStringLiteral(expr)) return expr.text.trim() === "" ? "missing" : "present";
      // Any other expression is dynamic/computed — unknowable, so "could name it".
      return "dynamic";
    }
    return "dynamic";
  }
  return "missing";
}

/** Whether ANY of the named attributes resolves a name (present or dynamic). */
export function anyNameAttr(
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  sf: ts.SourceFile,
  names: readonly string[],
): boolean {
  return names.some((n) => attrState(opening, sf, n) !== "missing");
}

/**
 * Whether an input's `type` exempts it from the name check (see
 * {@link NAME_EXEMPT_INPUT_TYPES}). A static exempt value or a dynamic
 * `type={x}` (unknowable → skip) exempts; a missing or non-exempt static `type`
 * does not. Only meaningful for inputs — `<select>`/`<textarea>` carry no `type`,
 * so this is always `false` for them (they are always checked).
 */
export function isNameExemptInputType(
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  sf: ts.SourceFile,
): boolean {
  for (const attr of opening.attributes.properties) {
    if (!ts.isJsxAttribute(attr) || attr.name.getText(sf) !== "type") continue;
    const init = attr.initializer;
    if (init === undefined) return false; // bare `type` — degenerate, treat as text
    if (ts.isStringLiteral(init)) return NAME_EXEMPT_INPUT_TYPES.has(init.text.trim().toLowerCase());
    if (ts.isJsxExpression(init)) {
      const expr = init.expression;
      if (expr !== undefined && ts.isStringLiteral(expr)) {
        return NAME_EXEMPT_INPUT_TYPES.has(expr.text.trim().toLowerCase());
      }
      return true; // `type={x}` — unknowable, exempt (uncertain → skip)
    }
    return true;
  }
  return false; // no `type` → defaults to "text" → checked
}

/**
 * Whether a control is statically HIDDEN or removed from the tab order, so an
 * absent label is not a real finding (uncertain → skip, FN-safe):
 *   - `tabIndex={-1}` / `tabIndex="-1"` — not keyboard-reachable in normal flow;
 *     in practice a hidden sentinel (react-select's required-field `<input>`) or
 *     a programmatically-focused target, externally driven, not a typed control;
 *   - the HTML `hidden` attribute (bare or `={true}`) — not rendered;
 *   - a `display:none` utility class (the standalone `hidden` token, Tailwind &
 *     co.) — removed from the accessibility tree, so it is never announced.
 * This mirrors the wide-sample false positives the native-control path would
 * otherwise produce (~7%): all six were one of these three shapes.
 */
export function isHiddenOrUntabbable(
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  sf: ts.SourceFile,
): boolean {
  for (const attr of opening.attributes.properties) {
    if (!ts.isJsxAttribute(attr)) continue;
    const name = attr.name.getText(sf);
    const init = attr.initializer;
    if (name === "hidden") {
      if (init === undefined) return true; // bare `hidden`
      if (ts.isJsxExpression(init) && init.expression?.kind === ts.SyntaxKind.TrueKeyword) return true;
      continue;
    }
    if (name === "tabIndex" && init !== undefined) {
      if (init.getText(sf).replace(/[{}"'\s]/g, "") === "-1") return true;
      continue;
    }
    if (name === "className" || name === "class") {
      let str: string | null = null;
      if (init !== undefined && ts.isStringLiteral(init)) str = init.text;
      else if (init !== undefined && ts.isJsxExpression(init) && init.expression !== undefined && ts.isStringLiteral(init.expression)) {
        str = init.expression.text;
      }
      if (str !== null && /(^|\s)hidden(\s|$)/.test(str)) return true;
    }
  }
  return false;
}

/**
 * Whether a JSX element is (or renders) a LABEL container — so an input nested
 * under it likely gets its name from that label and must NOT be flagged:
 *
 *   - intrinsic `<label>`;
 *   - `<X as="label">` / `<X component="label">` (Saleor `Box as="label"`, MUI);
 *   - a component whose leaf name ends with `Label` (`FormLabel`, `InputLabel`);
 *   - a form-field grouping (`FormItem`/`FormControl`/`FormField`/`FormGroup`)
 *     — the react-hook-form / shadcn / MUI convention that pairs a label with
 *     the control it wraps. Recognizing the GROUP is conservative: it suppresses
 *     even when the label sibling is rendered conditionally or further out.
 */
export function isLabelContainer(
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  sf: ts.SourceFile,
): boolean {
  const tag = opening.tagName;
  if (ts.isIdentifier(tag) && tag.text === "label") return true;
  // `as`/`component` polymorphic prop set to the string "label".
  for (const attr of opening.attributes.properties) {
    if (!ts.isJsxAttribute(attr)) continue;
    const n = attr.name.getText(sf);
    if (n !== "as" && n !== "component") continue;
    const init = attr.initializer;
    if (init !== undefined && ts.isStringLiteral(init) && init.text === "label") return true;
    if (
      init !== undefined &&
      ts.isJsxExpression(init) &&
      init.expression !== undefined &&
      ts.isStringLiteral(init.expression) &&
      init.expression.text === "label"
    ) {
      return true;
    }
  }
  const leaf = ts.isPropertyAccessExpression(tag)
    ? tag.name.text
    : ts.isIdentifier(tag)
      ? tag.text
      : "";
  if (leaf.endsWith("Label")) return true;
  return /^(Form(Item|Control|Field|Group)|Field)$/.test(leaf);
}

/**
 * Whether an element is a NAME-INJECTING wrapper for its single child control: a
 * design-system `<Tooltip>` carrying a `title` (or `aria-label`). MUI / antd /
 * Mantine Tooltips clone their child and set the `title` as the child's
 * `aria-label` by default (MUI: `describeChild=false` ⇒ "the title acts as an
 * accessible label for the child"). So a nested icon-only `<IconButton>` /
 * `<Button>` / `<Link>` is NAMED at runtime even though the call site shows no
 * `aria-label` — the actionable-control analogue of an input under a `<label>`.
 *
 * Matched on the LEAF name `Tooltip` (so `Tooltip`, `MyTooltip`, `Tooltip.Root`
 * all qualify) AND only when a `title`/`aria-label` is actually present — a
 * Tooltip with no title injects no name, so it must not suppress. A bare
 * `describeChild` Tooltip (title → description, not name) is the rare opposite;
 * we accept the small false-negative risk there in exchange for killing the
 * dominant, idiomatic titled-Tooltip false positive.
 */
export function isNameInjectingWrapper(
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  sf: ts.SourceFile,
): boolean {
  const tag = opening.tagName;
  const leaf = ts.isPropertyAccessExpression(tag)
    ? tag.name.text
    : ts.isIdentifier(tag)
      ? tag.text
      : "";
  if (!leaf.endsWith("Tooltip")) return false;
  // The title must actually be there to inject a name (present or dynamic).
  return attrState(opening, sf, "title") !== "missing" || anyNameAttr(opening, sf, LABEL_ATTRS);
}
