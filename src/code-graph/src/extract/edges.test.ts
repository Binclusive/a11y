import { Project, type SourceFile } from "ts-morph";
import { describe, expect, it } from "vitest";
import { resolveEdges } from "./edges.js";
import { discoverFunctions } from "./functions.js";

/**
 * Edge-pass fixtures. `resolveEdges` is the public surface over C1 (callee
 * resolution), C2 (inverted calledBy), and C5 (SCC chain depth). We build a
 * type-aware in-memory Project so symbol resolution works within the file, then
 * assert spec-correct call ids and chain depths (SPEC §8). All call sites are in
 * ONE file so callees resolve internally.
 */
function resolve(source: string) {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { strict: false },
    // Skip loading TS lib files / dep resolution: callees resolve to functions
    // DEFINED IN the fixture (or fall through to external:NAME), never against
    // lib globals, so this only makes the cold TS-compiler init cheap.
    skipLoadingLibFiles: true,
    skipFileDependencyResolution: true,
    skipAddingFilesFromTsConfig: true,
  });
  const sf: SourceFile = project.createSourceFile("fixture.ts", source);
  const { functions, nodeToId } = discoverFunctions("/", [sf]);
  const ids = functions.map((f) => f.id);
  return { result: resolveEdges("/", [sf], nodeToId, ids), ids };
}

/** Multi-file variant — the only way to exercise CROSS-FILE call resolution. */
function resolveMulti(files: { path: string; source: string }[]) {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { strict: false },
    // Same as resolve(): cross-file callees resolve via the fixtures' own
    // imports/exports, not lib globals, so skipping lib/dep loading is safe
    // and removes the cold TS-compiler lib-load cost.
    skipLoadingLibFiles: true,
    skipFileDependencyResolution: true,
    skipAddingFilesFromTsConfig: true,
  });
  const sfs: SourceFile[] = files.map((f) => project.createSourceFile(f.path, f.source));
  const { functions, nodeToId } = discoverFunctions("/", sfs);
  const ids = functions.map((f) => f.id);
  return { result: resolveEdges("/", sfs, nodeToId, ids), ids };
}

describe("resolveCallee / C1 — callee ids", () => {
  it("resolved internal call → callee's function id", () => {
    const src = `function a() { return 1; }
function b() { return a(); }`;
    const { result } = resolve(src);
    const bCalls = result.callsById.get("fixture.ts:b") ?? [];
    expect(bCalls.map((c) => c.calleeId)).toContain("fixture.ts:a");
  });

  it("unresolved external call → external:NAME", () => {
    const src = `function b() { return globalThing(); }`;
    const { result } = resolve(src);
    const bCalls = result.callsById.get("fixture.ts:b") ?? [];
    expect(bCalls.map((c) => c.calleeId)).toContain("external:globalThing");
  });

  it("property-access external uses the last name", () => {
    const src = `function b(x) { return x.doStuff(); }`;
    const { result } = resolve(src);
    const bCalls = result.callsById.get("fixture.ts:b") ?? [];
    expect(bCalls.map((c) => c.calleeId)).toContain("external:doStuff");
  });
});

describe("resolveCallee / C1 — CROSS-FILE imported calls (import-alias regression)", () => {
  // An imported callee's symbol is the import ALIAS; resolution must follow
  // getAliasedSymbol() to the real declaration. Without that, every
  // `import { f }; f()` call falls through to external:* and calledBy is empty.
  const FILES = [
    { path: "/a.ts", source: "export function helper() { return 1; }" },
    {
      path: "/b.ts",
      source: 'import { helper } from "./a";\nexport function caller() { return helper(); }',
    },
  ];

  it("an imported function call resolves to the real callee id across files", () => {
    const { result } = resolveMulti(FILES);
    const callerCalls = result.callsById.get("b.ts:caller") ?? [];
    expect(callerCalls.map((c) => c.calleeId)).toContain("a.ts:helper");
  });

  it("calledBy inverts across files (the blast-radius promise)", () => {
    const { result } = resolveMulti(FILES);
    const helperCalledBy = result.calledById.get("a.ts:helper") ?? [];
    expect(helperCalledBy.map((c) => c.callerId)).toContain("b.ts:caller");
  });
});

describe("A1 — overload signatures collapse to the implementation", () => {
  // `parse` has two overload signatures (no body) + one implementation (body).
  // Only the implementation is enumerated, so there is ONE `parse` node and the
  // caller resolves to it — not to a phantom bodyless first signature.
  const src = `export function parse(x: string): number;
export function parse(x: number): number;
export function parse(x: string | number): number { return Number(x); }
export function caller() { return parse("1"); }`;

  it("enumerates exactly one `parse` node (the implementation)", () => {
    const { ids } = resolve(src);
    expect(ids.filter((id) => id === "fixture.ts:parse")).toEqual(["fixture.ts:parse"]);
  });

  it("the caller resolves to the single parse id (not a phantom signature)", () => {
    const { result } = resolve(src);
    const callerCalls = result.callsById.get("fixture.ts:caller") ?? [];
    expect(callerCalls.map((c) => c.calleeId)).toContain("fixture.ts:parse");
  });
});

describe("computeChainDepths (C5) — SCC longest path", () => {
  it("a leaf with no internal callees has depth 0", () => {
    const src = `function leaf() { return 1; }`;
    const { result } = resolve(src);
    expect(result.chainDepthById.get("fixture.ts:leaf")).toBe(0);
  });

  it("self-recursion collapses to depth 1", () => {
    const src = `function r(n) { return n > 0 ? r(n - 1) : 0; }`;
    const { result } = resolve(src);
    expect(result.chainDepthById.get("fixture.ts:r")).toBe(1);
  });

  it("mutual recursion a↔b collapses the SCC to depth 1", () => {
    const src = `function a(n) { return b(n); }
function b(n) { return a(n); }`;
    const { result } = resolve(src);
    expect(result.chainDepthById.get("fixture.ts:a")).toBe(1);
    expect(result.chainDepthById.get("fixture.ts:b")).toBe(1);
  });

  it("DAG longest path: a→b→c gives depths 2,1,0", () => {
    const src = `function c() { return 1; }
function b() { return c(); }
function a() { return b(); }`;
    const { result } = resolve(src);
    expect(result.chainDepthById.get("fixture.ts:a")).toBe(2);
    expect(result.chainDepthById.get("fixture.ts:b")).toBe(1);
    expect(result.chainDepthById.get("fixture.ts:c")).toBe(0);
  });

  it("externals are excluded from the chain", () => {
    const src = `function a() { return globalThing(); }`;
    const { result } = resolve(src);
    // Only an external callee → no internal chain → depth 0.
    expect(result.chainDepthById.get("fixture.ts:a")).toBe(0);
  });
});

describe("C2 calledBy — inverted from calls", () => {
  it("a callee's calledBy lists its internal callers", () => {
    const src = `function a() { return 1; }
function b() { return a(); }`;
    const { result } = resolve(src);
    const aCalledBy = result.calledById.get("fixture.ts:a") ?? [];
    expect(aCalledBy.map((c) => c.callerId)).toContain("fixture.ts:b");
  });

  it("external callees never receive callers", () => {
    const src = `function b() { return globalThing(); }`;
    const { result } = resolve(src);
    expect(result.calledById.has("external:globalThing")).toBe(false);
  });
});
