/**
 * The Liquid AST layer — L1 of the Shopify/Liquid static producer (issue #47).
 *
 * This is the parser foundation the structural-absence rules (L2) and the
 * `collect-liquid` producer + `check-shopify` command (L3) build on. It wraps
 * `@shopify/liquid-html-parser` (Shopify's own theme-check parser) and exposes the
 * one distinction the whole precision invariant rides on: an HTML attribute can be
 * ABSENT, or PRESENT with a value that is static text, a render-time Liquid
 * expression (dynamic), or empty. A dynamic value means the attribute IS present —
 * conflating "value is dynamic" with "attribute missing" is the false positive that
 * gets an a11y tool uninstalled, so it is isolated and tested here, not in the rules.
 *
 * Liquid holes (`{{ }}` / `{% %}`) stay opaque: the parser keeps them as Liquid
 * nodes, never text/markup that could trip a rule. Parsing runs in tolerant mode so
 * odd real-world theme markup falls back to a string node instead of throwing.
 *
 * Pattern docs (read before changing this): `.patterns/liquid-html-parser/`
 * (`parsing.md`, `attributes.md`, `traversal.md`).
 */

import {
  getName,
  NodeTypes,
  toLiquidHtmlAST,
  walk,
  type AttrDoubleQuoted,
  type AttrEmpty,
  type AttrSingleQuoted,
  type AttrUnquoted,
  type DocumentNode,
  type HtmlElement,
  type HtmlRawNode,
  type HtmlSelfClosingElement,
  type HtmlVoidElement,
  type LiquidHtmlNode,
} from "@shopify/liquid-html-parser";

/** The HTML element node kinds that carry an `attributes` list. */
export type HtmlElementNode =
  | HtmlElement
  | HtmlVoidElement
  | HtmlSelfClosingElement
  | HtmlRawNode;

/** The concrete attribute node kinds (`{% if %}`-wrapped Liquid nodes are descended,
 * never returned as attributes). */
export type AttrNode = AttrSingleQuoted | AttrDoubleQuoted | AttrUnquoted | AttrEmpty;

/**
 * Parse result. Tolerant-mode parsing never throws on `{{ }}`/`{% %}`, but an
 * unclosed HTML/Liquid block still throws by default — we catch it and return
 * `{ ok: false }` so a producer scanning a whole theme never crashes on one
 * malformed file. The caller (L3) decides whether to skip or surface it.
 */
export type ParseResult =
  | { readonly ok: true; readonly ast: DocumentNode }
  | { readonly ok: false; readonly error: Error };

/**
 * How an HTML attribute's value resolves when read statically from `.liquid`.
 * The discriminant is what the structural-absence rules branch on: only `absent`
 * (and, per rule, `empty`) is ever a finding — `dynamic` is present-and-unknowable
 * and must never be flagged.
 */
export type AttrValue =
  | { readonly kind: "absent" } // no such attribute node on the element
  | { readonly kind: "empty" } // present, no value (AttrEmpty, or value=[])
  | { readonly kind: "static"; readonly text: string } // value is purely literal text
  | { readonly kind: "dynamic" }; // value contains a Liquid expression

/** Byte-offset span into the source — for L2/L3 to anchor a finding's location. */
export interface SourceSpan {
  readonly start: number; // 0-indexed, inclusive
  readonly end: number; // 0-indexed, exclusive
}

const HTML_ELEMENT_TYPES: ReadonlySet<string> = new Set([
  NodeTypes.HtmlElement,
  NodeTypes.HtmlVoidElement,
  NodeTypes.HtmlSelfClosingElement,
  NodeTypes.HtmlRawNode,
]);

const ATTR_TYPES: ReadonlySet<string> = new Set([
  NodeTypes.AttrSingleQuoted,
  NodeTypes.AttrDoubleQuoted,
  NodeTypes.AttrUnquoted,
  NodeTypes.AttrEmpty,
]);

/**
 * Parse a `.liquid` source string into an AST. Tolerant mode: unrecognized Liquid
 * markup falls back to a string node rather than throwing, so a real-world theme
 * with odd tags still parses. An unclosed document throws (the parser default);
 * we catch and return it as `{ ok: false }`.
 */
export function parseLiquid(source: string): ParseResult {
  try {
    const ast = toLiquidHtmlAST(source, {
      mode: "tolerant",
      allowUnclosedDocumentNode: false,
    });
    return { ok: true, ast };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
  }
}

/** Is this node an HTML element (i.e. does it carry an `attributes` list)? */
export function isHtmlElement(node: LiquidHtmlNode): node is HtmlElementNode {
  return HTML_ELEMENT_TYPES.has(node.type);
}

/**
 * Visit every HTML element node in the tree. Uses the library's `walk`, which
 * descends into attributes and name arrays too — plain `children` recursion would
 * silently skip them.
 */
export function eachHtmlElement(
  ast: DocumentNode,
  fn: (node: HtmlElementNode) => void,
): void {
  walk(ast, (node: LiquidHtmlNode) => {
    if (isHtmlElement(node)) fn(node);
  });
}

/** The element's tag name, normalized to a string (`getName` handles both the
 * plain-string void-element form and the compound array form). `null` if unnamed. */
export function elementName(node: HtmlElementNode): string | null {
  return getName(node);
}

/**
 * All attribute nodes on an element, descending into a `{% if %}`-wrapped attribute
 * list so an attribute hidden inside a Liquid tag still counts as present. The
 * returned nodes are the real `Attr*` nodes, never the Liquid wrapper.
 */
export function htmlAttributes(node: HtmlElementNode): AttrNode[] {
  const out: AttrNode[] = [];
  const collect = (attrs: readonly LiquidHtmlNode[]): void => {
    for (const a of attrs) {
      if (ATTR_TYPES.has(a.type)) {
        out.push(a as AttrNode);
      } else if ("children" in a && Array.isArray((a as { children?: unknown }).children)) {
        collect((a as unknown as { children: LiquidHtmlNode[] }).children);
      }
    }
  };
  collect(node.attributes as readonly LiquidHtmlNode[]);
  return out;
}

/** Find the attribute node named `name` (case-insensitive) on an element, if any. */
export function findAttr(node: HtmlElementNode, name: string): AttrNode | undefined {
  const target = name.toLowerCase();
  return htmlAttributes(node).find((a) => {
    const n = getName(a);
    return n != null && n.toLowerCase() === target;
  });
}

/**
 * Classify an attribute node into absent / empty / static / dynamic. `undefined`
 * (the result of a failed lookup) is `absent`. Presence is decided by node
 * existence, never by whether the value is empty or dynamic — see
 * `.patterns/liquid-html-parser/attributes.md`.
 */
export function classifyAttr(attr: AttrNode | undefined): AttrValue {
  if (!attr) return { kind: "absent" };
  if (attr.type === NodeTypes.AttrEmpty) return { kind: "empty" };
  const value = (attr as { value?: Array<{ type: string; value?: string }> }).value;
  if (!value || value.length === 0) return { kind: "empty" };
  const allText = value.every((v) => v.type === NodeTypes.TextNode);
  if (allText) return { kind: "static", text: value.map((v) => v.value ?? "").join("") };
  return { kind: "dynamic" };
}

/** Convenience: classify attribute `name` on `node` in one call. */
export function attr(node: HtmlElementNode, name: string): AttrValue {
  return classifyAttr(findAttr(node, name));
}

/** The source span a node covers, for anchoring a finding's location. */
export function spanOf(node: LiquidHtmlNode): SourceSpan {
  const position = (node as { position: SourceSpan }).position;
  return { start: position.start, end: position.end };
}

/**
 * The exact source text a node covers, reconstructed from its position span. The
 * one way to read inside an `HtmlRawNode` (`<svg>`, `<script>`, `<style>`): its
 * body is opaque raw markup, never parsed into child nodes, so a name source like
 * an `<svg>`'s `<title>` is only visible here. See
 * `.patterns/liquid-html-parser/node-taxonomy.md` (HtmlRawNode) and `traversal.md`
 * (source position). Returns `""` if the node carries no `source`/`position`.
 */
export function rawSourceOf(node: LiquidHtmlNode): string {
  const source = (node as { source?: string }).source;
  const position = (node as { position?: SourceSpan }).position;
  if (typeof source !== "string" || !position) return "";
  return source.slice(position.start, position.end);
}
