import { describe, expect, it } from "vitest";
import type { CallerSite, FunctionNode, Graph } from "../schema.js";
import { ThresholdsSchema } from "../schema.js";
import { smellsForFunction } from "../smells/evaluate.js";
import { rankPlan } from "../smells/plan.js";
import { renderBlast } from "./blast.js";

/**
 * fanIn = distinct caller functions, excluding the function's own self-recursion
 * (SPEC §5, §8). `calledBy` keeps one entry per call SITE (§8-C2) so `--blast`
 * can point at each line; this pins that the three consumers agree:
 *  - `rankPlan` (`--by impact`) fanIn,
 *  - `smellsForFunction` (`high-fan-in`) calledByCount,
 *  - `renderBlast` external-caller count.
 * None of them count self-recursion; blast surfaces it as `recursiveSelfCalls`.
 */

const thresholds = ThresholdsSchema.parse({});

function fn(id: string, calledBy: CallerSite[], over: Partial<FunctionNode> = {}): FunctionNode {
  return {
    id,
    name: id,
    kind: "function",
    file: "f.ts",
    startLine: 1,
    endLine: 1,
    loc: 0,
    commentLines: 0,
    nestingDepth: 0,
    complexity: 0,
    isExported: false,
    isTest: false,
    edges: { calls: [], calledBy, callChainDepth: 0 },
    smells: [],
    ...over,
  };
}

/** Wrap functions in a minimal edge-pass Graph (renderBlast reads provenance + functions). */
function graphOf(functions: FunctionNode[]): Graph {
  return {
    root: "/root",
    provenance: { pass: "edges", tsConfig: "tsconfig.json", scope: "deep" },
    thresholds,
    summary: {
      health: "healthy",
      fileCount: 1,
      functionCount: functions.length,
      smellCount: 0,
      highSeverityCount: 0,
      worstFile: null,
      worstFunction: null,
      topTargets: [],
      parseFailures: [],
    },
    functions,
    modules: [],
    directories: [],
    smells: [],
    stats: {
      fileCount: 1,
      functionCount: functions.length,
      totalLoc: 0,
      totalCommentLines: 0,
      smellCount: 0,
      parseFailures: [],
    },
  };
}

type BlastJson = {
  callers: { callerId: string }[];
  recursiveSelfCalls: number;
};

function blastJson(graph: Graph, id: string): BlastJson {
  const { stdout, exitCode } = renderBlast(graph, id, true, false);
  expect(exitCode).toBe(0);
  expect(stdout).not.toBeNull();
  return JSON.parse(stdout ?? "");
}

describe("fanIn = distinct callers, excluding self-recursion", () => {
  // `g` is called by TWO distinct functions (a, b) AND calls itself 3 times.
  // calledBy has 5 SITES: a, b, g, g, g — the old `calledBy.length` read fanIn 5.
  const g = fn("f.ts:g", [
    { callerId: "f.ts:a", line: 2 },
    { callerId: "f.ts:b", line: 3 },
    { callerId: "f.ts:g", line: 8 },
    { callerId: "f.ts:g", line: 9 },
    { callerId: "f.ts:g", line: 10 },
  ]);
  const a = fn("f.ts:a", []);
  const b = fn("f.ts:b", []);
  const graph = graphOf([g, a, b]);

  it("plan fanIn counts 2 distinct callers, not 5 call sites", () => {
    const row = rankPlan([g, a, b], "impact").find((r) => r.id === "f.ts:g");
    expect(row?.components.fanIn).toBe(2);
    expect(row?.calledByCount).toBe(2);
  });

  it("blast lists 2 external callers and agrees with plan fanIn", () => {
    const out = blastJson(graph, "f.ts:g");
    expect(out.callers.map((c) => c.callerId).sort()).toEqual(["f.ts:a", "f.ts:b"]);
    // The load-bearing invariant: blast caller count === plan fanIn.
    const row = rankPlan([g, a, b], "impact").find((r) => r.id === "f.ts:g");
    expect(out.callers.length).toBe(row?.components.fanIn);
  });

  it("blast surfaces self-recursion as a separate signal, not as fan-in", () => {
    const out = blastJson(graph, "f.ts:g");
    expect(out.recursiveSelfCalls).toBe(3);
    expect(out.callers.some((c) => c.callerId === "f.ts:g")).toBe(false);
  });
});

describe("a purely self-recursive function has fanIn 0", () => {
  // `r` calls only itself, 14 sites (the phoenix Walk.ts:resolveNode shape).
  const recurSites: CallerSite[] = Array.from({ length: 14 }, (_, i) => ({
    callerId: "f.ts:r",
    line: i + 1,
  }));
  // complexity 50 keeps it a plausible plan target; only fanIn must read 0.
  const r = fn("f.ts:r", recurSites, { complexity: 50 });
  const graph = graphOf([r]);

  it("fanIn is 0 (self-recursion excluded), so high-fan-in does NOT fire", () => {
    const row = rankPlan([r], "impact").find((x) => x.id === "f.ts:r");
    expect(row?.components.fanIn).toBe(0);
    const kinds = smellsForFunction(r, thresholds).map((s) => s.kind);
    expect(kinds).not.toContain("high-fan-in");
  });

  it("blast shows 0 external callers and 14 self-calls", () => {
    const out = blastJson(graph, "f.ts:r");
    expect(out.callers.length).toBe(0);
    expect(out.recursiveSelfCalls).toBe(14);
  });
});
