import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  attr,
  eachHtmlElement,
  elementName,
  parseLiquid,
  spanOf,
  type AttrValue,
  type HtmlElementNode,
} from "../src/liquid-ast";

const here = dirname(fileURLToPath(import.meta.url));

/** Parse `source` and return the first HTML element whose tag name is `tag`. */
function firstElement(source: string, tag: string): HtmlElementNode {
  const result = parseLiquid(source);
  if (!result.ok) throw result.error;
  let found: HtmlElementNode | undefined;
  eachHtmlElement(result.ast, (node) => {
    if (!found && elementName(node) === tag) found = node;
  });
  if (!found) throw new Error(`no <${tag}> found in source`);
  return found;
}

describe("parseLiquid — opaque holes, no choking", () => {
  it("parses a representative theme section (loops, output, if-wrapped attrs)", () => {
    const source = readFileSync(join(here, "fixtures/liquid/product-card.liquid"), "utf8");
    const result = parseLiquid(source);
    expect(result.ok).toBe(true);
  });

  it("keeps {{ }} and {% %} as opaque Liquid nodes, not HTML elements", () => {
    const result = parseLiquid("{% for x in y %}{{ x.title }}{% endfor %}<img src='a'>");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const tags: Array<string | null> = [];
    eachHtmlElement(result.ast, (node) => tags.push(elementName(node)));
    // Only the <img> is an HTML element; the loop and output never become elements.
    expect(tags).toEqual(["img"]);
  });

  it("does not throw on a malformed (unclosed) document — returns ok:false", () => {
    const result = parseLiquid("<div><img src='a'>"); // unclosed <div>
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(Error);
  });
});

describe("attribute classification — present-dynamic vs absent vs static vs empty", () => {
  const kind = (source: string, tag: string, name: string): AttrValue["kind"] =>
    attr(firstElement(source, tag), name).kind;

  it("dynamic: a Liquid-expression value is PRESENT, never absent", () => {
    expect(kind(`<img alt="{{ image.alt }}">`, "img", "alt")).toBe("dynamic");
  });

  it("absent: no attribute node at all", () => {
    expect(kind(`<img src="a.png">`, "img", "alt")).toBe("absent");
  });

  it("static: a purely-literal value is readable at parse time", () => {
    const value = attr(firstElement(`<img alt="A red mug">`, "img"), "alt");
    expect(value).toEqual({ kind: "static", text: "A red mug" });
  });

  it("empty: AttrEmpty (valueless) and an empty quoted value are both 'empty'", () => {
    expect(kind(`<input disabled>`, "input", "disabled")).toBe("empty");
    expect(kind(`<img alt="">`, "img", "alt")).toBe("empty");
  });

  it("mixed literal + Liquid is dynamic (any Liquid piece wins)", () => {
    expect(kind(`<a href="https://{{ shop }}/x">link</a>`, "a", "href")).toBe("dynamic");
  });

  it("an {% if %}-wrapped attribute still counts as present", () => {
    // The alt lives inside a LiquidTag in the attribute list — must not read as absent.
    expect(kind(`<img {% if c %}alt="{{ a }}"{% endif %} src="x">`, "img", "alt")).toBe("dynamic");
  });

  it("attribute lookup is case-insensitive", () => {
    expect(kind(`<img ALT="A red mug">`, "img", "alt")).toBe("static");
  });
});

describe("spanOf — source location for findings", () => {
  it("returns the exact byte span of a node", () => {
    const source = `<img src="a.png">`;
    const img = firstElement(source, "img");
    const span = spanOf(img);
    expect(source.slice(span.start, span.end)).toBe(`<img src="a.png">`);
  });
});
