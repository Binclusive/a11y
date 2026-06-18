import ts from "typescript";
import { describe, expect, it } from "vitest";
import { corpusPatterns } from "../src/corpus";
import { collectIntrinsicElements } from "../src/intrinsic-elements";
import { R4_ELEMENT_PATTERNS } from "../src/retrieve";

/** Parse a TSX snippet into a SourceFile (the shape `collectIntrinsicElements` reads). */
function parse(src: string): ts.SourceFile {
  return ts.createSourceFile("snippet.tsx", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

/** The single intrinsic element of `tag` in `src` (assumes exactly one). */
function only(src: string, tag: string) {
  const els = collectIntrinsicElements(parse(src)).filter((e) => e.tag === tag);
  expect(els).toHaveLength(1);
  return els[0];
}

describe("R4_ELEMENT_PATTERNS table validity (corpus guard)", () => {
  // The analogue of the cert-allowlist assertion: every patternId the R4 table
  // maps an intrinsic tag to MUST be a real corpus pattern, so a renamed/removed
  // corpus pattern can never leave a dangling, never-grounding table entry.
  it("every patternId in the table is a real corpusPatterns() id", () => {
    const corpusIds = new Set(corpusPatterns().map((p) => p.id));
    const tableIds = Object.values(R4_ELEMENT_PATTERNS)
      .flat()
      .map((e) => e.id);
    expect(tableIds.length).toBeGreaterThan(0);
    for (const id of tableIds) {
      expect(corpusIds, `R4 table id "${id}" is not a corpus pattern`).toContain(id);
    }
  });
});

describe("collectIntrinsicElements: altState", () => {
  it("a self-closing `<img alt=\"x\"/>` extracts with altState present", () => {
    expect(only(`<img alt="x" />`, "img").signals.altState).toBe("present");
  });

  it("a bare `<img/>` extracts with altState missing", () => {
    expect(only(`<img />`, "img").signals.altState).toBe("missing");
  });

  it("a dynamic `<img alt={x}/>` extracts with altState dynamic", () => {
    expect(only(`<img alt={x} />`, "img").signals.altState).toBe("dynamic");
  });
});

describe("collectIntrinsicElements: hasVisibleText", () => {
  it("`<a>text</a>` has visible static text", () => {
    expect(only(`<a>text</a>`, "a").signals.hasVisibleText).toBe(true);
  });

  it("a self-closing `<a/>` has no visible text", () => {
    expect(only(`<a />`, "a").signals.hasVisibleText).toBe(false);
  });
});

describe("collectIntrinsicElements: tag filtering", () => {
  it("a lowercase tag not in the R4 table is still extracted (intrinsic = lowercase)", () => {
    const span = only(`<span>hi</span>`, "span");
    expect(span.tag).toBe("span");
  });

  it("a Capitalized `<Foo/>` is NOT extracted (component, not intrinsic)", () => {
    const els = collectIntrinsicElements(parse(`<Foo />`));
    expect(els).toHaveLength(0);
  });
});
