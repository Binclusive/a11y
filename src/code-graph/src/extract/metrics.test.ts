import { Project, type SourceFile } from "ts-morph";
import { describe, expect, it } from "vitest";
import { discoverFunctions } from "./functions.js";
import { computeFunctionMetrics, moduleCommentLines } from "./metrics.js";

/**
 * Inline-source fixtures: an in-memory ts-morph Project (no disk, no tsconfig),
 * mirroring the cheap pass. `parse` returns the SourceFile; `metricsOf` discovers
 * named callables and returns the metrics for one by name. These lock the
 * bug-prone metric core (SPEC §7) against spec-correct values.
 */
function parse(source: string, name = "fixture.ts"): SourceFile {
  const project = new Project({
    useInMemoryFileSystem: true,
    // Skip loading TS lib files / dep resolution: metrics resolve syntactic
    // structure within the fixture, never against lib globals, so this only
    // makes init cheap (cold TS-compiler lib load is slow on loaded runners).
    skipLoadingLibFiles: true,
    skipFileDependencyResolution: true,
    skipAddingFilesFromTsConfig: true,
  });
  return project.createSourceFile(name, source);
}

function metricsByName(source: string): Map<string, ReturnType<typeof computeFunctionMetrics>> {
  const sf = parse(source);
  const { functions } = discoverFunctions("/", [sf]);
  const out = new Map<string, ReturnType<typeof computeFunctionMetrics>>();
  for (const f of functions) out.set(f.name, computeFunctionMetrics(f.node));
  return out;
}

describe("complexity (B3) — token counting", () => {
  it("base complexity of a trivial function is 1", () => {
    const m = metricsByName("function f() { return 1; }");
    expect(m.get("f")?.complexity).toBe(1);
  });

  it("counts each && / || / ?? token exactly once (no double-count)", () => {
    // The bug that already happened: counting the BinaryExpression AND its token.
    // Three operators → 1 base + 3 = 4.
    const m = metricsByName("function f(a, b, c, d) { return a && b || c ?? d; }");
    expect(m.get("f")?.complexity).toBe(4);
  });

  it("counts each CaseClause but NOT default", () => {
    const src = `function f(x) {
      switch (x) {
        case 1: return 1;
        case 2: return 2;
        case 3: return 3;
        default: return 0;
      }
    }`;
    // 1 base + 3 cases (default excluded) = 4.
    expect(metricsByName(src).get("f")?.complexity).toBe(4);
  });

  it("counts ternary, catch, and loops", () => {
    const src = `function f(x) {
      try {
        for (const i of x) {}
        while (x) {}
        return x ? 1 : 2;
      } catch (e) {}
    }`;
    // 1 base + for-of + while + ternary + catch = 5.
    expect(metricsByName(src).get("f")?.complexity).toBe(5);
  });

  it("named-callable boundary: a nested NAMED fn does not inflate the parent", () => {
    const src = `function parent(a, b) {
      function child(c, d) { return c && d; }
      return a || b;
    }`;
    const m = metricsByName(src);
    // parent: 1 base + 1 (||) = 2. child's && belongs to child, not parent.
    expect(m.get("parent")?.complexity).toBe(2);
    expect(m.get("child")?.complexity).toBe(2);
  });

  it("anonymous callback DOES contribute to the enclosing function", () => {
    const src = `function f(arr) {
      return arr.map((x) => x && x.y);
    }`;
    // The anon callback's && counts toward f: 1 base + 1 = 2.
    expect(metricsByName(src).get("f")?.complexity).toBe(2);
  });
});

describe("nesting (B2) — isDepthIncreasing", () => {
  it("if-block increases depth", () => {
    const src = `function f(a) { if (a) { if (a) { return 1; } } }`;
    expect(metricsByName(src).get("f")?.nestingDepth).toBe(2);
  });

  it("loops increase depth", () => {
    const src = `function f(xs) { for (const x of xs) { while (x) { return 1; } } }`;
    expect(metricsByName(src).get("f")?.nestingDepth).toBe(2);
  });

  it("switch increases depth", () => {
    const src = `function f(x) { switch (x) { case 1: return 1; } }`;
    expect(metricsByName(src).get("f")?.nestingDepth).toBe(1);
  });

  it("catch increases depth", () => {
    const src = `function f() { try { return 1; } catch (e) { return 2; } }`;
    expect(metricsByName(src).get("f")?.nestingDepth).toBe(1);
  });

  it("anonymous callback body increases depth", () => {
    const src = `function f(arr) { return arr.map((x) => { return x; }); }`;
    expect(metricsByName(src).get("f")?.nestingDepth).toBe(1);
  });

  it("named-callable boundary stops depth accounting", () => {
    const src = `function parent() {
      function child() { if (1) { if (1) { return 1; } } }
      return 1;
    }`;
    const m = metricsByName(src);
    // parent's body has only the nested NAMED fn — depth stops at the boundary.
    expect(m.get("parent")?.nestingDepth).toBe(0);
    expect(m.get("child")?.nestingDepth).toBe(2);
  });
});

describe("comment counting (A4)", () => {
  it("does not double-count JSDoc (leading ranges already include it)", () => {
    const src = `/**
 * Two-line JSDoc.
 */
function f() { return 1; }`;
    // The 3 physical JSDoc lines, counted once — not added again via getJsDocs.
    expect(metricsByName(src).get("f")?.commentLines).toBe(3);
  });

  it("dedups consecutive line comments and counts inner comments", () => {
    const src = `// a
// b
function f() {
  // inner
  return 1;
}`;
    // 2 leading + 1 inner = 3.
    expect(metricsByName(src).get("f")?.commentLines).toBe(3);
  });

  it("counts TRAILING comments on every branch (no false dense-undocumented)", () => {
    // A fully-commented complex function whose comments are ALL trailing `// x`
    // after code. getLeadingCommentRanges() misses these; without the trailing
    // pass commentLines would be 0 and fire a false dense-undocumented.
    const src = `function f(x) {
  if (x > 0) return 1; // positive branch
  if (x < 0) return -1; // negative branch
  return 0; // zero branch
}`;
    const m = metricsByName(src);
    expect(m.get("f")?.commentLines).toBeGreaterThan(0);
    // 3 trailing comment lines, one per branch.
    expect(m.get("f")?.commentLines).toBe(3);
    // commentLines > 0 means dense-undocumented cannot fire on this function.
  });

  it("module total = file comment lines, each function count is a subset", () => {
    const src = `// top of file
function f() {
  // inside f
  return 1;
}
// between
function g() { return 2; }`;
    const sf = parse(src);
    const { functions } = discoverFunctions("/", [sf]);
    const total = moduleCommentLines(sf);
    const byName = new Map(
      functions.map((fn) => [fn.name, computeFunctionMetrics(fn.node).commentLines]),
    );
    // Three distinct comment lines in the file: top-of-file, inside f, between.
    expect(total).toBe(3);
    // f owns its leading `// top of file` + inner `// inside f` = 2; the
    // function count is always ⊆ the module total (SPEC §6-A4 invariant).
    expect(byName.get("f")).toBe(2);
    expect(byName.get("f") ?? 0).toBeLessThanOrEqual(total);
    expect(byName.get("g") ?? 0).toBeLessThanOrEqual(total);
  });
});

describe("LOC (B1)", () => {
  it("loc = endLine - startLine + 1, leading // not counted", () => {
    const src = `// leading comment, not part of loc
function f() {
  return 1;
}`;
    // The declaration spans 3 physical lines (function … through closing }).
    expect(metricsByName(src).get("f")?.loc).toBe(3);
  });
});
