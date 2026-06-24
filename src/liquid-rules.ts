/**
 * The Liquid structural-absence rule set — L2 of the Shopify/Liquid producer (#47).
 *
 * Each rule walks the L1 AST and fires ONLY on a structural absence that is
 * decidable from source: an attribute that does not exist, an interactive control
 * with no name source anywhere in its subtree. A rule never fires when the thing it
 * checks is present-but-dynamic (`alt="{{ image.alt }}"`) — L1's classifier draws
 * that line and this layer honors it. That is the precision invariant: a false
 * positive on a render-time value is the failure mode that gets the tool uninstalled.
 *
 * What is deliberately NOT here: every runtime/computed check (see
 * {@link RUNTIME_EXCLUSIONS}). Color contrast, nested-interactive, required-children,
 * computed ARIA roles — those need a rendered DOM and belong to `check-url` (axe),
 * not a static source pass. The live audits on real Shopify themes confirmed those
 * classes dominate at runtime; this layer owns the structural floor only.
 *
 * Shape: each rule maps to a WCAG SC (the bridge below, the analog of `wcag-tags.ts`)
 * and emits the canonical {@link Finding}. `file` and `enforcement` come from the
 * caller's {@link LiquidRuleContext} (L3 supplies them from the file walk + config);
 * the rule owns `ruleId`, `message`, `wcag`, and the source `line`.
 *
 * Prior art: `.patterns/theme-check-common/html-attribute-checks.md` (Shopify's own
 * `ImgWidthAndHeight` — "`.find()` returned undefined → report").
 */

import { NodeTypes, type DocumentNode, type LiquidHtmlNode } from "@shopify/liquid-html-parser";
import type { EnforcementLevel } from "./config-scan";
import type { Finding } from "./core";
import {
  attr,
  elementName,
  isHtmlElement,
  rawSourceOf,
  spanOf,
  type HtmlElementNode,
} from "./liquid-ast";

/** What L3 supplies so a rule can finalize a {@link Finding} it can't know itself. */
export interface LiquidRuleContext {
  /** The `.liquid` file path the finding is anchored in. */
  readonly file: string;
  /** The full source string — used to map a node's byte offset to a 1-based line. */
  readonly source: string;
  /** The enforcement level for this file, from the governing config. */
  readonly enforcement: EnforcementLevel;
  /**
   * File-scoped indexes derived once per run (not supplied by L3). They let a
   * per-node rule consult whole-file context — the set of static `id`s in the file,
   * the set of ids a `<label for>` points at, and a node's ancestor chain — without
   * re-walking the tree. {@link runLiquidRules} populates them before running rules.
   */
  readonly idsInFile?: ReadonlySet<string>;
  readonly labelTargets?: ReadonlySet<string>;
  readonly ancestorsOf?: (node: HtmlElementNode) => readonly HtmlElementNode[];
}

/**
 * The WCAG SC bridge: each Liquid rule id → its success criteria. The analog of
 * `wcag-tags.ts` for axe — our rule ids are our own, so the mapping is direct.
 * `enrichAll` keys off these SC strings, exactly as the other producers' findings do.
 */
const RULE_WCAG: Readonly<Record<string, readonly string[]>> = {
  "liquid/img-no-alt": ["1.1.1"],
  "liquid/html-no-lang": ["3.1.1"],
  "liquid/iframe-no-title": ["4.1.2"],
  "liquid/control-no-name": ["4.1.2"],
  // R1 — form-control labeling (#59)
  "liquid/input-no-label": ["1.3.1", "4.1.2"],
  "liquid/label-for-dangling": ["1.3.1"],
  // R2 — document structure (#60)
  "liquid/heading-order": ["1.3.1"],
  "liquid/empty-heading": ["1.3.1", "2.4.6"],
  "liquid/list-structure": ["1.3.1"],
  // R3 — media naming (#61)
  "liquid/svg-no-name": ["1.1.1"],
  "liquid/media-no-captions": ["1.2.2", "1.2.3"],
  "liquid/area-no-alt": ["1.1.1"],
  // R4 — page / meta (#62)
  "liquid/viewport-no-scale": ["1.4.4"],
  "liquid/duplicate-id": ["4.1.1"],
  "liquid/positive-tabindex": ["2.4.3"],
};

/** WCAG SCs for a Liquid rule id (empty if unknown — never throws). */
export function wcagForLiquidRule(ruleId: string): readonly string[] {
  return RULE_WCAG[ruleId] ?? [];
}

/**
 * Runtime/computed rule classes deliberately NOT implemented as static Liquid rules
 * — they require a rendered DOM (computed roles, contrast, interactivity, layout)
 * and are owned by the `check-url` (axe) path. Documented so the boundary is explicit
 * and a future contributor doesn't try to fake them statically.
 */
export const RUNTIME_EXCLUSIONS: readonly string[] = [
  "color-contrast", // 1.4.3 — needs computed colors
  "nested-interactive", // 4.1.2 — needs computed interactivity
  "aria-required-children", // 1.3.1 — needs the full computed subtree
  "aria-required-parent", // 1.3.1
  "scrollable-region-focusable", // 2.1.1 — needs layout/overflow
  "target-size", // 2.5.8 — needs computed box size
];

/** Map a byte offset into `source` to a 1-based line number. */
function lineAt(source: string, offset: number): number {
  let line = 1;
  const stop = Math.min(offset, source.length);
  for (let i = 0; i < stop; i++) {
    if (source.charCodeAt(i) === 10 /* \n */) line++;
  }
  return line;
}

function makeFinding(
  ruleId: string,
  message: string,
  node: HtmlElementNode,
  ctx: LiquidRuleContext,
): Finding {
  return {
    file: ctx.file,
    line: lineAt(ctx.source, spanOf(node).start),
    ruleId,
    message,
    wcag: RULE_WCAG[ruleId] ?? [],
    enforcement: ctx.enforcement,
    provenance: "liquid",
  };
}

/** Does any of these naming attributes exist on the element (present in any form)? */
function hasNameAttr(node: HtmlElementNode): boolean {
  return (
    attr(node, "aria-label").kind !== "absent" ||
    attr(node, "aria-labelledby").kind !== "absent" ||
    attr(node, "title").kind !== "absent"
  );
}

/** True if the element is an `<svg>` (which the parser models as an `HtmlRawNode`). */
function isSvg(node: HtmlElementNode): boolean {
  return elementName(node)?.toLowerCase() === "svg";
}

/** Is this `<svg>` explicitly hidden from assistive tech (`aria-hidden="true"`)? */
function svgIsHidden(node: HtmlElementNode): boolean {
  return /\baria-hidden\s*=\s*["']?\s*true\b/i.test(rawSourceOf(node));
}

/**
 * Does this `<svg>` carry an accessible-name source? An `<svg>` parses as an opaque
 * `HtmlRawNode` — its inner `<title>` is in raw markup, never child nodes — so the
 * probe scans the raw source: a `<title>` element (SVG-AAM name-from-content), or an
 * `aria-label`/`aria-labelledby`/`title` attribute, or `role="img"`. Conservative by
 * design: any of these makes the SVG named, so an ancestor control is silent (#55).
 */
function svgHasName(node: HtmlElementNode): boolean {
  const raw = rawSourceOf(node);
  return (
    /<title[\s>]/i.test(raw) ||
    /\baria-label(ledby)?\s*=/i.test(raw) ||
    /\btitle\s*=/i.test(raw) ||
    /\brole\s*=\s*["']?\s*img\b/i.test(raw)
  );
}

/**
 * Conservative accessible-name probe for an interactive control: true if any name
 * source exists *anywhere* in the subtree — static text, dynamic `{{ }}` text, a
 * naming attribute on the control or a descendant, or a descendant `<img>` whose
 * `alt` is not absent. Deliberately over-accepts (under-reports) to protect
 * precision: the rule fires only when the control is unambiguously nameless.
 */
function subtreeHasName(node: HtmlElementNode): boolean {
  let named = false;
  const visit = (n: LiquidHtmlNode): void => {
    if (named) return;
    if (n.type === NodeTypes.TextNode) {
      const value = (n as { value?: string }).value;
      if (typeof value === "string" && value.trim() !== "") named = true;
      return;
    }
    if (n.type === NodeTypes.LiquidVariableOutput) {
      named = true; // a render-time {{ }} text node is a (present) name source
      return;
    }
    if (isHtmlElement(n)) {
      if (hasNameAttr(n)) {
        named = true;
        return;
      }
      if (elementName(n) === "img" && attr(n, "alt").kind !== "absent") {
        named = true;
        return;
      }
      // A descendant `<svg>` with a name source (a raw `<title>`, `aria-label`,
      // `role="img"`+label) gives the control a name via the SVG-AAM name-from-
      // content path — the icon-button pattern. Its `<title>` is raw, not a child
      // node, so probe the raw source here rather than recursing (#55).
      if (isSvg(n) && svgHasName(n)) {
        named = true;
        return;
      }
    }
    const kids = "children" in n && Array.isArray((n as { children?: unknown }).children)
      ? ((n as unknown as { children: LiquidHtmlNode[] }).children)
      : [];
    for (const k of kids) visit(k);
  };
  visit(node);
  return named;
}

type LiquidRule = (node: HtmlElementNode, ctx: LiquidRuleContext) => Finding | null;

/** `<img>` with no `alt` attribute at all (a dynamic or empty alt is present → silent). */
const imgNoAlt: LiquidRule = (node, ctx) => {
  if (elementName(node) !== "img") return null;
  if (attr(node, "alt").kind !== "absent") return null;
  return makeFinding(
    "liquid/img-no-alt",
    "Image has no `alt` attribute — screen readers announce nothing for it. Add `alt` text, or `alt=\"\"` if decorative.",
    node,
    ctx,
  );
};

/** `<html>` with no `lang` attribute. */
const htmlNoLang: LiquidRule = (node, ctx) => {
  if (elementName(node) !== "html") return null;
  if (attr(node, "lang").kind !== "absent") return null;
  return makeFinding(
    "liquid/html-no-lang",
    "`<html>` has no `lang` attribute — assistive tech can't determine the page language.",
    node,
    ctx,
  );
};

/** `<iframe>` with no `title` attribute. */
const iframeNoTitle: LiquidRule = (node, ctx) => {
  if (elementName(node) !== "iframe") return null;
  if (attr(node, "title").kind !== "absent") return null;
  return makeFinding(
    "liquid/iframe-no-title",
    "`<iframe>` has no `title` attribute — its purpose is not announced to screen readers.",
    node,
    ctx,
  );
};

/** `<button>`, or `<a href>`, with no accessible name source anywhere in its subtree. */
const controlNoName: LiquidRule = (node, ctx) => {
  const name = elementName(node);
  const isButton = name === "button";
  const isLink = name === "a" && attr(node, "href").kind !== "absent";
  if (!isButton && !isLink) return null;
  if (subtreeHasName(node)) return null;
  const label = isButton ? "Button" : "Link";
  return makeFinding(
    "liquid/control-no-name",
    `${label} has no accessible name — no text, \`aria-label\`, or labelled child. Screen readers announce it without a purpose.`,
    node,
    ctx,
  );
};

// ---------------------------------------------------------------------------
// R1 — form-control labeling (#59)
// ---------------------------------------------------------------------------

/** `<input>` types that are not user-facing text fields and never need a label. */
const UNLABELED_INPUT_TYPES: ReadonlySet<string> = new Set([
  "hidden",
  "submit",
  "button",
  "image",
  "reset",
]);

/** Does this control carry a self-naming attribute (`aria-label`/`aria-labelledby`/`title`)? */
function hasSelfLabel(node: HtmlElementNode): boolean {
  return hasNameAttr(node);
}

/** The nearest ancestor element name chain — used to detect a wrapping `<label>`. */
function hasAncestorLabel(node: HtmlElementNode, ctx: LiquidRuleContext): boolean {
  const ancestors = ctx.ancestorsOf?.(node) ?? [];
  return ancestors.some((a) => elementName(a)?.toLowerCase() === "label");
}

/**
 * `<input>` (text-like), `<select>`, or `<textarea>` with no accessible-name source:
 * no `aria-label`/`aria-labelledby`/`title`, no `for`-associated or ancestor
 * `<label>`. Conservative — a dynamic naming value is present → silent; any doubt
 * about a label source → silent (under-report to protect precision).
 */
const inputNoLabel: LiquidRule = (node, ctx) => {
  const name = elementName(node)?.toLowerCase();
  if (name !== "input" && name !== "select" && name !== "textarea") return null;
  if (name === "input") {
    const type = attr(node, "type");
    if (type.kind === "static" && UNLABELED_INPUT_TYPES.has(type.text.trim().toLowerCase())) {
      return null;
    }
    // A dynamic `type="{{ }}"` could resolve to an excluded type — stay silent.
    if (type.kind === "dynamic") return null;
  }
  if (hasSelfLabel(node)) return null;
  // A `for`-associated `<label>` in the same file makes it labelled.
  const id = attr(node, "id");
  if (id.kind === "static" && ctx.labelTargets?.has(id.text.trim())) return null;
  if (id.kind === "dynamic") return null; // a dynamic id may be a label target — silent.
  if (hasAncestorLabel(node, ctx)) return null;
  return makeFinding(
    "liquid/input-no-label",
    `\`<${name}>\` has no associated label — no \`aria-label\`, no \`<label for>\`, no wrapping \`<label>\`. Screen readers announce it without a purpose.`,
    node,
    ctx,
  );
};

/**
 * `<label for="X">` whose `X` matches no element `id` in the same file. Scoped to the
 * file (cross-file association is not statically decidable); a dynamic `for` is silent.
 */
const labelForDangling: LiquidRule = (node, ctx) => {
  if (elementName(node)?.toLowerCase() !== "label") return null;
  const forAttr = attr(node, "for");
  if (forAttr.kind !== "static") return null; // absent/empty/dynamic → not decidable.
  const target = forAttr.text.trim();
  if (target === "") return null;
  if (ctx.idsInFile?.has(target)) return null;
  return makeFinding(
    "liquid/label-for-dangling",
    `\`<label for="${target}">\` points to no element with \`id="${target}"\` in this file — the label is not associated with any control.`,
    node,
    ctx,
  );
};

// ---------------------------------------------------------------------------
// R2 — document structure (#60)
// ---------------------------------------------------------------------------

const HEADING_TAGS: ReadonlySet<string> = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

/** The numeric level of a heading tag (`h2` → 2), or `null` if not a heading. */
function headingLevel(node: HtmlElementNode): number | null {
  const name = elementName(node)?.toLowerCase();
  if (name && HEADING_TAGS.has(name)) return Number(name[1]);
  return null;
}

/** A heading (`h1`–`h6`) with no text and no dynamic `{{ }}` content in its subtree. */
const emptyHeading: LiquidRule = (node, ctx) => {
  if (headingLevel(node) === null) return null;
  // `subtreeHasName` already means "any text or dynamic `{{ }}` content present".
  if (subtreeHasName(node)) return null;
  return makeFinding(
    "liquid/empty-heading",
    `\`<${elementName(node)}>\` is empty — a heading with no text gives screen-reader users a meaningless landmark.`,
    node,
    ctx,
  );
};

/** Direct-child element tags that don't count as a list-structure violation. */
const LIST_CONTENT_IGNORE: ReadonlySet<string> = new Set(["li", "script", "template"]);

/**
 * A `<ul>`/`<ol>` with a direct child *element* that is not `<li>` (ignoring text,
 * `{% %}` wrappers, `<script>`, `<template>`). A `{% for %}`/`{% if %}` wraps its
 * `<li>` in a Liquid node, which is transparent here — so loop-built lists are silent.
 */
const listStructure: LiquidRule = (node, ctx) => {
  const name = elementName(node)?.toLowerCase();
  if (name !== "ul" && name !== "ol") return null;
  const children = (node as { children?: LiquidHtmlNode[] }).children ?? [];
  const offender = children.find(
    (c) => isHtmlElement(c) && !LIST_CONTENT_IGNORE.has(elementName(c)?.toLowerCase() ?? ""),
  );
  if (!offender) return null;
  return makeFinding(
    "liquid/list-structure",
    `\`<${name}>\` has a direct child \`<${elementName(offender as HtmlElementNode)}>\` that is not \`<li>\` — only \`<li>\` may be a direct child of a list.`,
    node,
    ctx,
  );
};

// ---------------------------------------------------------------------------
// R3 — media naming (#61)
// ---------------------------------------------------------------------------

/** Tags that own their own accessible name (an `<svg>` inside one is covered there). */
const NAME_OWNING_ANCESTORS: ReadonlySet<string> = new Set(["a", "button", "label", "summary"]);

/**
 * A standalone informative `<svg>` with no name source: no `<title>`,
 * `aria-label`/`aria-labelledby`, `role`, and not `aria-hidden="true"`. An `<svg>`
 * inside an interactive control is the icon-button case `control-no-name` already
 * owns, so it is skipped here to avoid double-reporting. The svg parses as an
 * `HtmlRawNode`, so name sources are read from its raw markup.
 */
const svgNoName: LiquidRule = (node, ctx) => {
  if (!isSvg(node)) return null;
  if (svgIsHidden(node)) return null; // decorative → exempt.
  if (svgHasName(node)) return null;
  const inControl = (ctx.ancestorsOf?.(node) ?? []).some((a) =>
    NAME_OWNING_ANCESTORS.has(elementName(a)?.toLowerCase() ?? ""),
  );
  if (inControl) return null; // covered by `control-no-name`.
  // `role=` on the svg (presentation/none/img/anything) means the author has made an
  // intentional choice — conservative: any role → silent.
  if (/\brole\s*=/i.test(rawSourceOf(node))) return null;
  return makeFinding(
    "liquid/svg-no-name",
    "`<svg>` has no accessible name — no `<title>`, `aria-label`, or `role`. Add a `<title>`, or `aria-hidden=\"true\"` if decorative.",
    node,
    ctx,
  );
};

/** Does this `<video>`/`<audio>` have any `<track>` child element? */
function hasTrackChild(node: HtmlElementNode): boolean {
  const children = (node as { children?: LiquidHtmlNode[] }).children ?? [];
  return children.some((c) => isHtmlElement(c) && elementName(c)?.toLowerCase() === "track");
}

/** A `<video>`/`<audio>` with no `<track>` child (captions/subtitles source). */
const mediaNoCaptions: LiquidRule = (node, ctx) => {
  const name = elementName(node)?.toLowerCase();
  if (name !== "video" && name !== "audio") return null;
  if (hasTrackChild(node)) return null;
  return makeFinding(
    "liquid/media-no-captions",
    `\`<${name}>\` has no \`<track>\` — deaf and hard-of-hearing users get no captions or subtitles.`,
    node,
    ctx,
  );
};

/** An image-map `<area>` with no `alt` attribute. */
const areaNoAlt: LiquidRule = (node, ctx) => {
  if (elementName(node)?.toLowerCase() !== "area") return null;
  if (attr(node, "alt").kind !== "absent") return null;
  return makeFinding(
    "liquid/area-no-alt",
    "`<area>` has no `alt` attribute — its image-map region is announced without a purpose. Add `alt` text.",
    node,
    ctx,
  );
};

// ---------------------------------------------------------------------------
// R4 — page / meta (#62)
// ---------------------------------------------------------------------------

/** A `<meta name="viewport">` whose `content` disables zoom. */
const viewportNoScale: LiquidRule = (node, ctx) => {
  if (elementName(node)?.toLowerCase() !== "meta") return null;
  const metaName = attr(node, "name");
  if (metaName.kind !== "static" || metaName.text.trim().toLowerCase() !== "viewport") return null;
  const content = attr(node, "content");
  if (content.kind !== "static") return null; // dynamic content → not decidable → silent.
  const value = content.text.toLowerCase();
  const disablesZoom =
    /user-scalable\s*=\s*(no|0)/.test(value) || maximumScaleUnderTwo(value);
  if (!disablesZoom) return null;
  return makeFinding(
    "liquid/viewport-no-scale",
    "`<meta name=\"viewport\">` disables zoom (`user-scalable=no`/`maximum-scale<2`) — low-vision users can't pinch-zoom the page.",
    node,
    ctx,
  );
};

/** True if the viewport content sets `maximum-scale` to a value below 2. */
function maximumScaleUnderTwo(content: string): boolean {
  const match = /maximum-scale\s*=\s*([0-9.]+)/.exec(content);
  if (!match) return false;
  const scale = Number(match[1]);
  return Number.isFinite(scale) && scale < 2;
}

/** An element with a static `tabindex` greater than 0. */
const positiveTabindex: LiquidRule = (node, ctx) => {
  const tabindex = attr(node, "tabindex");
  if (tabindex.kind !== "static") return null; // dynamic/absent → silent.
  const value = Number(tabindex.text.trim());
  if (!Number.isFinite(value) || value <= 0) return null;
  return makeFinding(
    "liquid/positive-tabindex",
    `\`tabindex="${tabindex.text.trim()}"\` forces a positive tab order — it breaks the natural focus sequence. Use \`0\` or \`-1\`.`,
    node,
    ctx,
  );
};

/** The full structural-absence rule set, in evaluation order. */
const RULES: readonly LiquidRule[] = [
  imgNoAlt,
  htmlNoLang,
  iframeNoTitle,
  controlNoName,
  inputNoLabel,
  labelForDangling,
  emptyHeading,
  listStructure,
  svgNoName,
  mediaNoCaptions,
  areaNoAlt,
  viewportNoScale,
  positiveTabindex,
];

// ---------------------------------------------------------------------------
// File-level rules (#60 heading-order, #62 duplicate-id) — they need the whole
// element sequence, not a single node, so they run once over an ordered list of
// the file's elements rather than per node.
// ---------------------------------------------------------------------------

/**
 * A heading that skips a level relative to the preceding heading in document order
 * (e.g. an `h2` followed by an `h4`). The first heading and any descent (`h4`→`h2`)
 * or equal level are fine. A dynamic heading tag (`<h{{ n }}>`) has no static level,
 * so it neither fires nor resets the tracker — handled gracefully by skipping it.
 */
function headingOrderFindings(
  ordered: readonly HtmlElementNode[],
  ctx: LiquidRuleContext,
): Finding[] {
  const findings: Finding[] = [];
  let last: number | null = null;
  for (const node of ordered) {
    const level = headingLevel(node);
    if (level === null) continue;
    if (last !== null && level > last + 1) {
      findings.push(
        makeFinding(
          "liquid/heading-order",
          `Heading level jumps from \`h${last}\` to \`h${level}\` — a skipped level breaks the document outline for screen-reader users.`,
          node,
          ctx,
        ),
      );
    }
    last = level;
  }
  return findings;
}

/**
 * Two or more elements in the file sharing the same static `id`. Dynamic ids
 * (`id="{{ }}"`) are not statically decidable and are skipped. One finding per
 * duplicate occurrence after the first, anchored on the offending element.
 */
function duplicateIdFindings(
  ordered: readonly HtmlElementNode[],
  ctx: LiquidRuleContext,
): Finding[] {
  const findings: Finding[] = [];
  const seen = new Set<string>();
  for (const node of ordered) {
    const id = attr(node, "id");
    if (id.kind !== "static") continue;
    const value = id.text.trim();
    if (value === "") continue;
    if (seen.has(value)) {
      findings.push(
        makeFinding(
          "liquid/duplicate-id",
          `Duplicate \`id="${value}"\` — an id must be unique in a document; assistive-tech associations (\`for\`, \`aria-labelledby\`) resolve to the wrong element.`,
          node,
          ctx,
        ),
      );
    } else {
      seen.add(value);
    }
  }
  return findings;
}

/** The static `id` value on an element, or `null` if absent/empty/dynamic. */
function staticId(node: HtmlElementNode): string | null {
  const id = attr(node, "id");
  if (id.kind !== "static") return null;
  const value = id.text.trim();
  return value === "" ? null : value;
}

/** The static `for` target on a `<label>`, or `null`. */
function labelForTarget(node: HtmlElementNode): string | null {
  if (elementName(node)?.toLowerCase() !== "label") return null;
  const forAttr = attr(node, "for");
  if (forAttr.kind !== "static") return null;
  const value = forAttr.text.trim();
  return value === "" ? null : value;
}

/**
 * Run every structural-absence rule over a parsed Liquid AST, returning the findings.
 * The single entry point L3's producer calls per file.
 *
 * Two passes: first an ordered walk builds the file-scoped indexes (every element in
 * document order, the set of static ids, the `for`-target ids, and an ancestor map),
 * which file-level rules and label-aware per-node rules consult; then per-node rules
 * run over each element with that context, and the file-level rules run once.
 */
export function runLiquidRules(ast: DocumentNode, baseCtx: LiquidRuleContext): Finding[] {
  const ordered: HtmlElementNode[] = [];
  const idsInFile = new Set<string>();
  const labelTargets = new Set<string>();
  const parentOf = new Map<HtmlElementNode, HtmlElementNode | null>();

  // One pre-order recursion: collect elements in document order, index ids and
  // label targets, and record each element's parent (for ancestor lookup).
  const visit = (n: LiquidHtmlNode, parentEl: HtmlElementNode | null): void => {
    let nextParent = parentEl;
    if (isHtmlElement(n)) {
      ordered.push(n);
      parentOf.set(n, parentEl);
      const id = staticId(n);
      if (id !== null) idsInFile.add(id);
      const forTarget = labelForTarget(n);
      if (forTarget !== null) labelTargets.add(forTarget);
      nextParent = n;
    }
    const kids =
      "children" in n && Array.isArray((n as { children?: unknown }).children)
        ? (n as unknown as { children: LiquidHtmlNode[] }).children
        : [];
    for (const k of kids) visit(k, nextParent);
  };
  visit(ast, null);

  const ancestorsOf = (node: HtmlElementNode): HtmlElementNode[] => {
    const chain: HtmlElementNode[] = [];
    let p = parentOf.get(node) ?? null;
    while (p) {
      chain.push(p);
      p = parentOf.get(p) ?? null;
    }
    return chain;
  };

  const ctx: LiquidRuleContext = { ...baseCtx, idsInFile, labelTargets, ancestorsOf };

  const findings: Finding[] = [];
  for (const node of ordered) {
    for (const rule of RULES) {
      const finding = rule(node, ctx);
      if (finding) findings.push(finding);
    }
  }
  findings.push(...headingOrderFindings(ordered, ctx));
  findings.push(...duplicateIdFindings(ordered, ctx));
  return findings;
}
