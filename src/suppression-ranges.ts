import ts from "typescript";

/**
 * Finding-suppression line ranges: spans of a file where a static finding would
 * be a false positive because the source doesn't reflect the runtime / a11y
 * tree. Two sources — runtime child-injection (Trans / render-delegation,
 * detailed below) and `aria-hidden` subtrees. Callers union the ranges and skip
 * any finding on a covered line.
 *
 * ── Runtime child-injection ──
 *
 * Content rules (`anchor-has-content`, `heading-has-content`,
 * `anchor-is-valid`) assume the element they fire on is empty because it has no
 * JSX children. Two widely-used React patterns break that assumption by
 * injecting children at RUNTIME, so the JSX looks childless but the rendered
 * element is not. Both produce the same false positive, from the same cause:
 *
 * 1. react-i18next `<Trans>` interpolation. Elements passed in
 *    `components={[...]}` / `components={{ key: <El/> }}` receive the
 *    translated string's `<0>…</0>` placeholder text as their children:
 *
 *        <Trans defaults="<0>Create an account</0>"
 *               components={[<a href="/register" />]} />
 *
 *    The `<a/>` is contentful at runtime.
 *
 * 2. Render-delegation props (`render={<El/>}` in base-ui / MUI Base, the value
 *    of `asChild` chains in Radix). The host component renders AS the delegated
 *    element and forwards ITS OWN children into it:
 *
 *        <BreadcrumbLink render={<Link href="/polls" />}>
 *          <Icon /> <Trans defaults="Polls" />
 *        </BreadcrumbLink>
 *
 *    The `<Link/>` (an anchor) renders with the breadcrumb's icon+text children.
 *
 * The fix is semantic, scoped, and false-negative-safe:
 *   - We suppress ONLY content-family findings (the rules whose "no children"
 *     premise the injection invalidates). ARIA/role/handler findings on the
 *     same element still surface.
 *   - For render-delegation we suppress ONLY when the host element actually
 *     HAS children to inject — a `<Button render={<Link/>} />` with no children
 *     is a genuinely empty anchor and must still flag.
 *
 * Triggers are public component/prop APIs, not per-repo conventions: the
 * react-i18next `Trans` component, and the `render` delegation prop. Both reach
 * us as plain JSX names regardless of which module they were imported from.
 *
 * A customer can name THEIR OWN `<Trans>`-like helpers via `binclusive.json`
 * `injectsChildren`. Those names are treated exactly like the built-in `Trans`:
 * their `components={...}` targets are runtime-contentful, AND the helper element
 * ITSELF is treated as contentful (a custom helper typically replaces its own
 * children with the translated string). This is the escape hatch for the same
 * runtime-injection pattern when the helper isn't literally named `Trans`.
 */

/**
 * jsx-a11y rules whose finding is invalidated by runtime child injection,
 * because each one's premise is "this element has no text content." Scoped
 * deliberately: ARIA/role/handler rules are NOT here, so an injected element
 * with a real ARIA bug still surfaces.
 */
const CONTENT_RULES: ReadonlySet<string> = new Set([
  "jsx-a11y/anchor-has-content",
  "jsx-a11y/anchor-is-valid",
  "jsx-a11y/heading-has-content",
]);

/** The JSX component name react-i18next exposes for interpolation. */
const TRANS_TAG = "Trans";
/** The prop on `<Trans>` that carries the interpolation target elements. */
const COMPONENTS_PROP = "components";
/** The render-delegation prop (base-ui / MUI Base): host renders AS this element. */
const RENDER_PROP = "render";

/** A 1-based source line range, inclusive, of a suppressed element. */
interface LineRange {
  readonly start: number;
  readonly end: number;
}

/**
 * Scan a source file for every JSX element whose children are injected at
 * runtime — via `<Trans components={...}>` or a `render={<El/>}` delegation on
 * a host element that supplies children. Returns the 1-based line ranges those
 * elements occupy; a content-rule finding on a covered line is a false positive.
 *
 * `injectsChildren` is the customer's list of THEIR OWN `Trans`-like helper
 * names (from `binclusive.json`). Each is treated identically to the built-in
 * `Trans`: its `components={...}` targets are suppressed, and the helper element
 * itself is suppressed (a custom helper replaces its own children at runtime).
 */
export function transInjectedLineRanges(
  sf: ts.SourceFile,
  injectsChildren: readonly string[] = [],
): LineRange[] {
  const ranges: LineRange[] = [];
  const customTags = new Set(injectsChildren);

  const lineOf = (pos: number): number => sf.getLineAndCharacterOfPosition(pos).line + 1;

  const recordElement = (node: ts.Node): void => {
    ranges.push({ start: lineOf(node.getStart(sf)), end: lineOf(node.getEnd()) });
  };

  // Every JSX element nested under a `<Trans>` `components` value receives
  // injected text, so both `[<a/>]` and `{ a: <a/> }` are captured.
  const collectInjected = (node: ts.Node): void => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) recordElement(node);
    ts.forEachChild(node, collectInjected);
  };

  /** The trailing name of a JSX tag (`NS.Member` -> `Member`), else the name. */
  const tagLeafName = (tagName: ts.JsxTagNameExpression): string | null => {
    if (ts.isIdentifier(tagName)) return tagName.text;
    if (ts.isPropertyAccessExpression(tagName)) return tagName.name.text;
    return null;
  };

  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      const leaf = tagLeafName(opening.tagName);
      const isCustomInjector = leaf !== null && customTags.has(leaf);

      if (isTransTag(opening.tagName) || isCustomInjector) {
        // A customer's own helper replaces ITS OWN children at runtime, so the
        // helper element itself is contentful — suppress it directly.
        if (isCustomInjector) recordElement(node);
        for (const attr of opening.attributes.properties) {
          if (!ts.isJsxAttribute(attr)) continue;
          if (attr.name.getText(sf) !== COMPONENTS_PROP) continue;
          const init = attr.initializer;
          if (init !== undefined && ts.isJsxExpression(init) && init.expression !== undefined) {
            collectInjected(init.expression);
          }
        }
      }

      // Render-delegation: suppress the delegated element only when the host
      // element supplies children for it to render. A childless host means a
      // genuinely empty delegated element — leave that finding alone.
      if (hostSuppliesChildren(node)) {
        const delegated = renderPropElement(opening, sf);
        if (delegated !== null) recordElement(delegated);
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sf);

  return ranges;
}

/**
 * Line ranges of JSX elements marked `aria-hidden` (`aria-hidden={true}` or
 * `aria-hidden="true"`). Such an element is removed from the accessibility tree
 * — a screen reader never reaches it — so the content-family rules whose whole
 * premise is "this element is reachable but empty" (`anchor-has-content`,
 * `anchor-is-valid`, `heading-has-content`) simply do not apply to it.
 *
 * Scope is deliberately narrow: ONLY content-family findings are suppressed
 * (via the shared {@link CONTENT_RULES} set + {@link isContentSuppressed}).
 * Everything else on an aria-hidden element — bad ARIA props, role mismatches,
 * interactive-without-handler — still surfaces, because hiding from the a11y
 * tree doesn't make those correct. And only `aria-hidden` set to a literal
 * truthy value counts: `aria-hidden={false}` / `aria-hidden={someVar}` are NOT
 * suppressed, so a dynamically-shown element keeps flagging.
 */
export function ariaHiddenLineRanges(sf: ts.SourceFile): LineRange[] {
  const ranges: LineRange[] = [];
  const lineOf = (pos: number): number => sf.getLineAndCharacterOfPosition(pos).line + 1;

  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      if (hasTruthyAriaHidden(opening, sf)) {
        ranges.push({ start: lineOf(node.getStart(sf)), end: lineOf(node.getEnd()) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return ranges;
}

/**
 * Line ranges of JSX elements whose children are forwarded through a `{...props}`
 * (or `{...rest}`) SPREAD, so the content-family rules cannot prove the element
 * is empty. This is the design-system primitive shape jsx-a11y is structurally
 * blind to:
 *
 *     const AlertTitle = forwardRef(({ className, ...props }, ref) => (
 *       <h5 ref={ref} className={cn(...)} {...props} />   // children arrive via {...props}
 *     ))
 *     const TabLink = ({ ...props }) => <a className="…" {...props} />
 *
 * The `<h5/>` / `<a/>` look childless in the JSX, so `heading-has-content` /
 * `anchor-has-content` fire — but the consumer passes the heading text / link
 * label as children, which flow in through the spread. Every shadcn/Radix-style
 * primitive that wraps a native `<h1-6>` / `<a>` and forwards props hits this,
 * turning the checker's own "find bugs inside your design system" surface into a
 * wall of false CRITICALs.
 *
 * Same scope + safety contract as the runtime-injection ranges above: ONLY
 * content-family findings (via {@link isContentSuppressed}) are suppressed, so an
 * ARIA/role/handler bug on the same spread element still surfaces. A spread can
 * carry `children` (or `dangerouslySetInnerHTML`); we cannot prove it doesn't, so
 * the "empty element" premise is unprovable here — exactly as it is for a
 * `render={<El/>}` delegation — and the content-family finding is withheld rather
 * than asserted as a false positive.
 *
 * Recorded only when the element has NO static contentful children of its own: an
 * element that already spells out children needs no spread to be contentful and
 * never fired a content finding anyway, so leaving it unrecorded keeps the range
 * set tight.
 */
export function spreadChildrenLineRanges(sf: ts.SourceFile): LineRange[] {
  const ranges: LineRange[] = [];
  const lineOf = (pos: number): number => sf.getLineAndCharacterOfPosition(pos).line + 1;

  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      const hasSpread = opening.attributes.properties.some((p) => ts.isJsxSpreadAttribute(p));
      if (hasSpread && !hasStaticChildren(node)) {
        ranges.push({ start: lineOf(node.getStart(sf)), end: lineOf(node.getEnd()) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return ranges;
}

/**
 * Whether a JSX element has static, contentful children written directly in the
 * JSX — non-whitespace text, a nested element/fragment, or an expression child.
 * A self-closing element has none. This is the inverse of "needs the spread to
 * be contentful": when true, the element is contentful on its own and is not a
 * spread-injection candidate.
 */
function hasStaticChildren(node: ts.JsxElement | ts.JsxSelfClosingElement): boolean {
  if (!ts.isJsxElement(node)) return false;
  return node.children.some((child) => {
    if (ts.isJsxText(child)) return child.text.trim() !== "";
    if (ts.isJsxExpression(child)) return child.expression !== undefined;
    return ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child) || ts.isJsxFragment(child);
  });
}

/** The `aria-hidden` attribute name. */
const ARIA_HIDDEN_PROP = "aria-hidden";

/**
 * Whether an opening element carries `aria-hidden` set to a literal truthy
 * value: bare (`<a aria-hidden>`), `aria-hidden={true}`, or `aria-hidden="true"`.
 * A literal `false`, or any dynamic expression, returns false — we only suppress
 * when the element is unconditionally hidden from the a11y tree.
 */
function hasTruthyAriaHidden(
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  sf: ts.SourceFile,
): boolean {
  for (const attr of opening.attributes.properties) {
    if (!ts.isJsxAttribute(attr)) continue;
    if (attr.name.getText(sf) !== ARIA_HIDDEN_PROP) continue;
    const init = attr.initializer;
    // Bare `aria-hidden` (no initializer) is `true`.
    if (init === undefined) return true;
    // `aria-hidden="true"`.
    if (ts.isStringLiteral(init)) return init.text === "true";
    // `aria-hidden={...}`.
    if (ts.isJsxExpression(init) && init.expression !== undefined) {
      const expr = init.expression;
      if (expr.kind === ts.SyntaxKind.TrueKeyword) return true;
      if (expr.kind === ts.SyntaxKind.FalseKeyword) return false;
      // `aria-hidden={"true"}`.
      if (ts.isStringLiteral(expr)) return expr.text === "true";
    }
    return false;
  }
  return false;
}

/** Whether a JSX tag-name node is the react-i18next `Trans` component. */
function isTransTag(tagName: ts.JsxTagNameExpression): boolean {
  if (ts.isIdentifier(tagName)) return tagName.text === TRANS_TAG;
  if (ts.isPropertyAccessExpression(tagName)) return tagName.name.text === TRANS_TAG;
  return false;
}

/**
 * The JSX element passed as a `render={<El/>}` delegation prop on `opening`, or
 * `null` when there is no such prop. The host will render AS this element.
 */
function renderPropElement(
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  sf: ts.SourceFile,
): ts.JsxElement | ts.JsxSelfClosingElement | null {
  for (const attr of opening.attributes.properties) {
    if (!ts.isJsxAttribute(attr)) continue;
    if (attr.name.getText(sf) !== RENDER_PROP) continue;
    const init = attr.initializer;
    if (init === undefined || !ts.isJsxExpression(init) || init.expression === undefined) continue;
    const expr = init.expression;
    if (ts.isJsxElement(expr) || ts.isJsxSelfClosingElement(expr)) return expr;
  }
  return null;
}

/**
 * Whether a host JSX element has children it would forward into a delegated
 * element. A self-closing host has none; an element host has children when any
 * child is non-whitespace JSX text or any nested element/expression. This is
 * the false-negative guard: only a child-bearing host can make an otherwise
 * empty delegated anchor contentful.
 */
function hostSuppliesChildren(node: ts.JsxElement | ts.JsxSelfClosingElement): boolean {
  if (!ts.isJsxElement(node)) return false;
  return node.children.some((child) => {
    if (ts.isJsxText(child)) return child.text.trim() !== "";
    if (ts.isJsxExpression(child)) return child.expression !== undefined;
    return ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child) || ts.isJsxFragment(child);
  });
}

/**
 * Decide whether a content-family finding at `line` is suppressed: true iff the
 * rule is a content-family rule (its "empty element" premise) AND the line falls
 * inside one of the supplied ranges. Both suppression sources share this gate:
 *
 *   - runtime child injection ({@link transInjectedLineRanges}) — the element
 *     gets content at render time, so "empty" is wrong.
 *   - `aria-hidden` ({@link ariaHiddenLineRanges}) — the element is out of the
 *     a11y tree, so "empty link/heading" doesn't apply.
 *
 * Non-content rules are NEVER suppressed, regardless of range — only the
 * content-family premise is invalidated by these two patterns.
 */
export function isContentSuppressed(
  ruleId: string,
  line: number,
  ranges: readonly LineRange[],
): boolean {
  if (!CONTENT_RULES.has(ruleId)) return false;
  return ranges.some((r) => line >= r.start && line <= r.end);
}
