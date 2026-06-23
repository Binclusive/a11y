import { describe, expect, it } from "vitest";
import type { Finding } from "../src/core";
import { parseLiquid } from "../src/liquid-ast";
import {
  RUNTIME_EXCLUSIONS,
  runLiquidRules,
  wcagForLiquidRule,
  type LiquidRuleContext,
} from "../src/liquid-rules";

const CTX: LiquidRuleContext = { file: "theme/section.liquid", source: "", enforcement: "block" };

/** Parse `source`, run the rules, return findings (with source threaded for line mapping). */
function run(source: string): Finding[] {
  const result = parseLiquid(source);
  if (!result.ok) throw result.error;
  return runLiquidRules(result.ast, { ...CTX, source });
}

const ruleIds = (source: string): string[] => run(source).map((f) => f.ruleId);

describe("liquid/img-no-alt — 1.1.1", () => {
  it("fires when alt is absent", () => {
    expect(ruleIds(`<img src="a.png">`)).toEqual(["liquid/img-no-alt"]);
  });
  it("stays silent when alt is a dynamic Liquid value (present, not absent)", () => {
    expect(ruleIds(`<img src="a" alt="{{ image.alt }}">`)).toEqual([]);
  });
  it("stays silent on a static alt and on an explicit empty (decorative) alt", () => {
    expect(ruleIds(`<img alt="A red mug">`)).toEqual([]);
    expect(ruleIds(`<img alt="">`)).toEqual([]);
  });
});

describe("liquid/html-no-lang — 3.1.1", () => {
  it("fires when lang is absent", () => {
    expect(ruleIds(`<html><body></body></html>`)).toEqual(["liquid/html-no-lang"]);
  });
  it("stays silent when lang is present (static or dynamic)", () => {
    expect(ruleIds(`<html lang="en"><body></body></html>`)).toEqual([]);
    expect(ruleIds(`<html lang="{{ request.locale.iso_code }}"><body></body></html>`)).toEqual([]);
  });
});

describe("liquid/iframe-no-title — 4.1.2", () => {
  it("fires when title is absent", () => {
    expect(ruleIds(`<iframe src="https://x"></iframe>`)).toEqual(["liquid/iframe-no-title"]);
  });
  it("stays silent when title is present", () => {
    expect(ruleIds(`<iframe src="https://x" title="Map"></iframe>`)).toEqual([]);
    expect(ruleIds(`<iframe src="x" title="{{ block.settings.title }}"></iframe>`)).toEqual([]);
  });
});

describe("liquid/control-no-name — 4.1.2", () => {
  it("fires on an empty button and an icon-only button", () => {
    expect(ruleIds(`<button></button>`)).toEqual(["liquid/control-no-name"]);
    expect(ruleIds(`<button><svg></svg></button>`)).toEqual(["liquid/control-no-name"]);
  });
  it("stays silent when the button has static text, dynamic text, or a label", () => {
    expect(ruleIds(`<button>Add to cart</button>`)).toEqual([]);
    expect(ruleIds(`<button>{{ 'products.add' | t }}</button>`)).toEqual([]);
    expect(ruleIds(`<button aria-label="Close"></button>`)).toEqual([]);
    expect(ruleIds(`<button aria-label="{{ x }}"></button>`)).toEqual([]);
  });
  it("treats a labelled child image as a name source", () => {
    expect(ruleIds(`<button><img alt="Cart"></button>`)).toEqual([]);
  });
  it("fires on a link with href but no name; ignores an anchor without href", () => {
    expect(ruleIds(`<a href="/cart"></a>`)).toEqual(["liquid/control-no-name"]);
    expect(ruleIds(`<a href="/cart">Cart</a>`)).toEqual([]);
    expect(ruleIds(`<a name="top"></a>`)).toEqual([]); // not a link — no href
  });
});

describe("Finding shape + WCAG bridge + exclusions", () => {
  it("every finding conforms to the Finding shape with provenance 'liquid' and a WCAG SC", () => {
    const [finding] = run(`<img src="a.png">`);
    expect(finding).toMatchObject({
      file: "theme/section.liquid",
      line: 1,
      ruleId: "liquid/img-no-alt",
      provenance: "liquid",
      enforcement: "block",
    });
    expect(finding.wcag).toEqual(["1.1.1"]);
    expect(typeof finding.message).toBe("string");
  });

  it("maps a node's line correctly", () => {
    const source = `<html lang="en">\n  <body>\n    <img src="a.png">\n  </body>\n</html>`;
    const [finding] = runLiquidRules(parseOk(source), { ...CTX, source });
    expect(finding.line).toBe(3);
  });

  it("the WCAG bridge resolves known ids and is empty for unknown", () => {
    expect(wcagForLiquidRule("liquid/img-no-alt")).toEqual(["1.1.1"]);
    expect(wcagForLiquidRule("liquid/control-no-name")).toEqual(["4.1.2"]);
    expect(wcagForLiquidRule("liquid/nonexistent")).toEqual([]);
  });

  it("documents the runtime/computed exclusions (owned by check-url, not static)", () => {
    expect(RUNTIME_EXCLUSIONS).toContain("color-contrast");
    expect(RUNTIME_EXCLUSIONS).toContain("nested-interactive");
    expect(RUNTIME_EXCLUSIONS).toContain("aria-required-children");
  });
});

function parseOk(source: string) {
  const result = parseLiquid(source);
  if (!result.ok) throw result.error;
  return result.ast;
}
