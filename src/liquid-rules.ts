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
import { attr, eachHtmlElement, elementName, isHtmlElement, spanOf, type HtmlElementNode } from "./liquid-ast";

/** What L3 supplies so a rule can finalize a {@link Finding} it can't know itself. */
export interface LiquidRuleContext {
  /** The `.liquid` file path the finding is anchored in. */
  readonly file: string;
  /** The full source string — used to map a node's byte offset to a 1-based line. */
  readonly source: string;
  /** The enforcement level for this file, from the governing config. */
  readonly enforcement: EnforcementLevel;
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

/** The full structural-absence rule set, in evaluation order. */
const RULES: readonly LiquidRule[] = [imgNoAlt, htmlNoLang, iframeNoTitle, controlNoName];

/**
 * Run every structural-absence rule over a parsed Liquid AST, returning the findings.
 * The single entry point L3's producer calls per file.
 */
export function runLiquidRules(ast: DocumentNode, ctx: LiquidRuleContext): Finding[] {
  const findings: Finding[] = [];
  eachHtmlElement(ast, (node) => {
    for (const rule of RULES) {
      const finding = rule(node, ctx);
      if (finding) findings.push(finding);
    }
  });
  return findings;
}
