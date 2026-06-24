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

  // #55 — a descendant <svg> with a name source gives the control a name.
  it("treats an SVG-titled icon as a name source (#55)", () => {
    expect(ruleIds(`<button><svg role="img"><title>Buy</title></svg></button>`)).toEqual([]);
    expect(ruleIds(`<a href="/x"><svg><title>Cart</title></svg></a>`)).toEqual([]);
    expect(ruleIds(`<button><svg aria-label="Search"></svg></button>`)).toEqual([]);
  });
  it("still fires on a genuinely nameless icon button (empty svg)", () => {
    expect(ruleIds(`<button><svg></svg></button>`)).toContain("liquid/control-no-name");
  });

  // #64 — a control out of the a11y tree (aria-hidden) is not a missing-name defect.
  it("stays silent when the control itself is aria-hidden=\"true\"", () => {
    expect(ruleIds(`<a href="/x" aria-hidden="true"><svg></svg></a>`)).toEqual([]);
    expect(ruleIds(`<button aria-hidden="true"></button>`)).toEqual([]);
  });
  it("stays silent when an ancestor is aria-hidden=\"true\"", () => {
    expect(ruleIds(`<div aria-hidden="true"><button></button></div>`)).toEqual([]);
    expect(ruleIds(`<span aria-hidden="true"><a href="/x"></a></span>`)).toEqual([]);
  });
  it("treats a dynamic aria-hidden as possibly-hidden (conservative skip)", () => {
    expect(ruleIds(`<button aria-hidden="{{ hide }}"></button>`)).toEqual([]);
  });
  it("still fires on a non-hidden empty control (aria-hidden=\"false\")", () => {
    expect(ruleIds(`<button aria-hidden="false"></button>`)).toEqual(["liquid/control-no-name"]);
    expect(ruleIds(`<div aria-hidden="false"><button></button></div>`)).toEqual([
      "liquid/control-no-name",
    ]);
  });
});

describe("liquid/input-no-label — 1.3.1/4.1.2", () => {
  it("fires when an input/select/textarea has no label source", () => {
    expect(ruleIds(`<input type="text">`)).toEqual(["liquid/input-no-label"]);
    expect(ruleIds(`<input>`)).toEqual(["liquid/input-no-label"]);
    expect(ruleIds(`<select><option>a</option></select>`)).toEqual(["liquid/input-no-label"]);
    expect(ruleIds(`<textarea></textarea>`)).toEqual(["liquid/input-no-label"]);
  });
  it("stays silent for each label source", () => {
    expect(ruleIds(`<input aria-label="Name">`)).toEqual([]); // aria-label
    expect(ruleIds(`<input aria-labelledby="lbl">`)).toEqual([]); // aria-labelledby
    expect(ruleIds(`<label for="n">Name</label><input id="n">`)).toEqual([]); // for+id
    expect(ruleIds(`<label><input></label>`)).toEqual([]); // ancestor <label>
  });
  it("stays silent on a dynamic naming value, dynamic id, and dynamic type", () => {
    expect(ruleIds(`<input aria-label="{{ x }}">`)).toEqual([]);
    expect(ruleIds(`<input id="{{ x }}">`)).toEqual([]);
    expect(ruleIds(`<input type="{{ t }}">`)).toEqual([]);
  });
  it("never fires for excluded input types", () => {
    for (const t of ["hidden", "submit", "button", "image", "reset"]) {
      expect(ruleIds(`<input type="${t}">`)).toEqual([]);
    }
  });
  it("carries the WCAG SCs 1.3.1 and 4.1.2", () => {
    const [f] = run(`<input type="text">`);
    expect(f.wcag).toEqual(["1.3.1", "4.1.2"]);
  });
});

describe("liquid/label-for-dangling — 1.3.1", () => {
  it("fires when `for` points to a non-existent in-file id", () => {
    expect(ruleIds(`<label for="ghost">Name</label>`)).toEqual(["liquid/label-for-dangling"]);
  });
  it("stays silent when `for` points to a real id", () => {
    expect(ruleIds(`<label for="n">Name</label><input id="n">`)).toEqual([]);
  });
  it("stays silent on a dynamic `for` (not statically decidable)", () => {
    expect(ruleIds(`<label for="{{ x }}">Name</label>`)).toEqual([]);
  });
  it("carries the WCAG SC 1.3.1", () => {
    const [f] = run(`<label for="ghost">Name</label>`);
    expect(f.wcag).toEqual(["1.3.1"]);
  });
});

describe("liquid/heading-order — 1.3.1", () => {
  it("fires on a skipped level", () => {
    expect(ruleIds(`<h2>A</h2><h4>B</h4>`)).toEqual(["liquid/heading-order"]);
  });
  it("stays silent on sequential, equal, and descending levels", () => {
    expect(ruleIds(`<h2>A</h2><h3>B</h3>`)).toEqual([]);
    expect(ruleIds(`<h2>A</h2><h2>B</h2>`)).toEqual([]);
    expect(ruleIds(`<h3>A</h3><h2>B</h2>`)).toEqual([]);
  });
  it("handles a dynamic heading tag gracefully (no level, no fire)", () => {
    expect(ruleIds(`<h{{ n }}>A</h{{ n }}>`)).toEqual([]);
  });
  it("carries the WCAG SC 1.3.1", () => {
    const [f] = run(`<h2>A</h2><h4>B</h4>`);
    expect(f.wcag).toEqual(["1.3.1"]);
  });
});

describe("liquid/empty-heading — 1.3.1/2.4.6", () => {
  it("fires on an empty heading", () => {
    expect(ruleIds(`<h2></h2>`)).toEqual(["liquid/empty-heading"]);
  });
  it("stays silent on text and on dynamic `{{ }}` content", () => {
    expect(ruleIds(`<h2>Section</h2>`)).toEqual([]);
    expect(ruleIds(`<h2>{{ section.title }}</h2>`)).toEqual([]);
  });
  it("carries the WCAG SCs 1.3.1 and 2.4.6", () => {
    const [f] = run(`<h2></h2>`);
    expect(f.wcag).toEqual(["1.3.1", "2.4.6"]);
  });
});

describe("liquid/list-structure — 1.3.1", () => {
  it("fires on a non-`<li>` direct child element", () => {
    expect(ruleIds(`<ul><div></div></ul>`)).toEqual(["liquid/list-structure"]);
  });
  it("stays silent on `<li>` children and on a `{% for %}`-wrapped `<li>`", () => {
    expect(ruleIds(`<ul><li></li></ul>`)).toEqual([]);
    expect(ruleIds(`<ul>{% for i in x %}<li></li>{% endfor %}</ul>`)).toEqual([]);
    expect(ruleIds(`<ul>{% if x %}<li></li>{% endif %}</ul>`)).toEqual([]);
  });
  it("carries the WCAG SC 1.3.1", () => {
    const [f] = run(`<ul><div></div></ul>`);
    expect(f.wcag).toEqual(["1.3.1"]);
  });
});

describe("liquid/svg-no-name — 1.1.1", () => {
  it("fires on a standalone informative svg with no name source", () => {
    expect(ruleIds(`<svg><path/></svg>`)).toEqual(["liquid/svg-no-name"]);
  });
  it("stays silent on a titled svg, a labelled svg, and an aria-hidden svg", () => {
    expect(ruleIds(`<svg><title>Logo</title></svg>`)).toEqual([]);
    expect(ruleIds(`<svg aria-label="Logo"></svg>`)).toEqual([]);
    expect(ruleIds(`<svg aria-hidden="true"></svg>`)).toEqual([]);
  });
  it("does not double-report an svg inside a control (control-no-name owns it)", () => {
    expect(ruleIds(`<button><svg></svg></button>`)).toEqual(["liquid/control-no-name"]);
  });
  it("stays silent on a standalone svg inside an aria-hidden ancestor (#64)", () => {
    expect(ruleIds(`<div aria-hidden="true"><svg><path/></svg></div>`)).toEqual([]);
  });
  it("carries the WCAG SC 1.1.1", () => {
    const [f] = run(`<svg><path/></svg>`);
    expect(f.wcag).toEqual(["1.1.1"]);
  });
});

describe("liquid/media-no-captions — 1.2.2/1.2.3", () => {
  it("fires on a video/audio with no track child", () => {
    expect(ruleIds(`<video src="x"></video>`)).toEqual(["liquid/media-no-captions"]);
    expect(ruleIds(`<audio src="x"></audio>`)).toEqual(["liquid/media-no-captions"]);
  });
  it("stays silent when a `<track>` child is present", () => {
    expect(ruleIds(`<video><track kind="captions"></video>`)).toEqual([]);
    expect(ruleIds(`<video><track></video>`)).toEqual([]);
  });
  it("carries the WCAG SCs 1.2.2 and 1.2.3", () => {
    const [f] = run(`<video src="x"></video>`);
    expect(f.wcag).toEqual(["1.2.2", "1.2.3"]);
  });
});

describe("liquid/area-no-alt — 1.1.1", () => {
  it("fires on an area with no alt", () => {
    expect(ruleIds(`<map><area shape="rect"></map>`)).toEqual(["liquid/area-no-alt"]);
  });
  it("stays silent on a static and a dynamic alt", () => {
    expect(ruleIds(`<map><area shape="rect" alt="Home"></map>`)).toEqual([]);
    expect(ruleIds(`<map><area shape="rect" alt="{{ x }}"></map>`)).toEqual([]);
  });
  it("carries the WCAG SC 1.1.1", () => {
    const [f] = run(`<map><area shape="rect"></map>`);
    expect(f.wcag).toEqual(["1.1.1"]);
  });
});

describe("liquid/viewport-no-scale — 1.4.4", () => {
  it("fires on `user-scalable=no` and `maximum-scale<2`", () => {
    expect(ruleIds(`<meta name="viewport" content="width=device-width, user-scalable=no">`)).toEqual(
      ["liquid/viewport-no-scale"],
    );
    expect(ruleIds(`<meta name="viewport" content="maximum-scale=1">`)).toEqual([
      "liquid/viewport-no-scale",
    ]);
  });
  it("stays silent on a scalable viewport, a >=2 max-scale, and dynamic content", () => {
    expect(ruleIds(`<meta name="viewport" content="width=device-width">`)).toEqual([]);
    expect(ruleIds(`<meta name="viewport" content="maximum-scale=5">`)).toEqual([]);
    expect(ruleIds(`<meta name="viewport" content="{{ x }}">`)).toEqual([]);
  });
  it("carries the WCAG SC 1.4.4", () => {
    const [f] = run(`<meta name="viewport" content="user-scalable=no">`);
    expect(f.wcag).toEqual(["1.4.4"]);
  });
});

describe("liquid/duplicate-id — 4.1.1", () => {
  it("fires on two static identical ids in one file", () => {
    expect(ruleIds(`<div id="a"></div><span id="a"></span>`)).toEqual(["liquid/duplicate-id"]);
  });
  it("stays silent on unique ids and on dynamic ids", () => {
    expect(ruleIds(`<div id="a"></div><span id="b"></span>`)).toEqual([]);
    expect(ruleIds(`<div id="{{ x }}"></div><span id="{{ x }}"></span>`)).toEqual([]);
  });
  it("carries the WCAG SC 4.1.1", () => {
    const [f] = run(`<div id="a"></div><span id="a"></span>`);
    expect(f.wcag).toEqual(["4.1.1"]);
  });
});

describe("liquid/positive-tabindex — 2.4.3", () => {
  it("fires on a positive tabindex", () => {
    expect(ruleIds(`<div tabindex="1"></div>`)).toEqual(["liquid/positive-tabindex"]);
    expect(ruleIds(`<div tabindex="5"></div>`)).toEqual(["liquid/positive-tabindex"]);
  });
  it("stays silent on `0`, `-1`, and dynamic tabindex", () => {
    expect(ruleIds(`<div tabindex="0"></div>`)).toEqual([]);
    expect(ruleIds(`<div tabindex="-1"></div>`)).toEqual([]);
    expect(ruleIds(`<div tabindex="{{ x }}"></div>`)).toEqual([]);
  });
  it("carries the WCAG SC 2.4.3", () => {
    const [f] = run(`<div tabindex="1"></div>`);
    expect(f.wcag).toEqual(["2.4.3"]);
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
    expect(wcagForLiquidRule("liquid/input-no-label")).toEqual(["1.3.1", "4.1.2"]);
    expect(wcagForLiquidRule("liquid/duplicate-id")).toEqual(["4.1.1"]);
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
