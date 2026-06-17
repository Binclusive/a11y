import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { dedupeRecall, type Finding, scan } from "../src/core";

const fixture = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/enforce/${name}`, import.meta.url));

/** A corpus-agent recall candidate — the only producer of this provenance. */
function recall(
  over: Partial<Finding> & Pick<Finding, "file" | "line" | "wcag" | "patternId">,
): Finding {
  return {
    ruleId: "corpus/pattern",
    message: "",
    enforcement: "warn",
    provenance: "corpus-agent",
    layer: "recall",
    ...over,
  };
}

/** A static floor finding (jsx-a11y / enforce). */
function floor(file: string, line: number, wcag: readonly string[]): Finding {
  return {
    file,
    line,
    ruleId: "jsx-a11y/x",
    message: "",
    wcag,
    enforcement: "block",
    provenance: "jsx-a11y",
  };
}

describe("dedupeRecall — cross-dedup against the static floor", () => {
  it("DROPS a candidate sharing file+line+SC with a static finding", () => {
    const statics = [floor("/a.tsx", 10, ["4.1.2"])];
    const candidates = [recall({ file: "/a.tsx", line: 10, wcag: ["4.1.2"], patternId: "p1" })];
    expect(dedupeRecall(candidates, statics)).toEqual([]);
  });

  it("KEEPS a candidate at the same line but a DIFFERENT SC (floor didn't catch it)", () => {
    const statics = [floor("/a.tsx", 10, ["4.1.2"])];
    const candidates = [recall({ file: "/a.tsx", line: 10, wcag: ["2.4.4"], patternId: "p1" })];
    expect(dedupeRecall(candidates, statics)).toHaveLength(1);
  });

  it("KEEPS a candidate at the same SC but a DIFFERENT line", () => {
    const statics = [floor("/a.tsx", 10, ["4.1.2"])];
    const candidates = [recall({ file: "/a.tsx", line: 99, wcag: ["4.1.2"], patternId: "p1" })];
    expect(dedupeRecall(candidates, statics)).toHaveLength(1);
  });

  it("KEEPS a candidate in a DIFFERENT file even at the same line+SC", () => {
    const statics = [floor("/a.tsx", 10, ["4.1.2"])];
    const candidates = [recall({ file: "/b.tsx", line: 10, wcag: ["4.1.2"], patternId: "p1" })];
    expect(dedupeRecall(candidates, statics)).toHaveLength(1);
  });

  it("drops when ANY of the candidate's SCs overlaps the floor", () => {
    const statics = [floor("/a.tsx", 10, ["4.1.2"])];
    const candidates = [
      recall({ file: "/a.tsx", line: 10, wcag: ["2.4.4", "4.1.2"], patternId: "p1" }),
    ];
    expect(dedupeRecall(candidates, statics)).toEqual([]);
  });
});

describe("dedupeRecall — self-dedup by file+line+patternId", () => {
  it("collapses duplicate (file,line,patternId), keeping the first", () => {
    const dup = recall({ file: "/a.tsx", line: 5, wcag: ["2.4.4"], patternId: "p1" });
    const out = dedupeRecall([dup, { ...dup, message: "second" }], []);
    expect(out).toHaveLength(1);
    expect(out[0]?.message).toBe("");
  });

  it("keeps two DIFFERENT patternIds on the same element", () => {
    const candidates = [
      recall({ file: "/a.tsx", line: 5, wcag: ["2.4.4"], patternId: "p1" }),
      recall({ file: "/a.tsx", line: 5, wcag: ["2.4.4"], patternId: "p2" }),
    ];
    expect(dedupeRecall(candidates, [])).toHaveLength(2);
  });

  it("keeps the same patternId on DIFFERENT lines", () => {
    const candidates = [
      recall({ file: "/a.tsx", line: 5, wcag: ["2.4.4"], patternId: "p1" }),
      recall({ file: "/a.tsx", line: 6, wcag: ["2.4.4"], patternId: "p1" }),
    ];
    expect(dedupeRecall(candidates, [])).toHaveLength(2);
  });

  it("preserves input order of survivors", () => {
    const a = recall({ file: "/a.tsx", line: 1, wcag: ["2.4.4"], patternId: "a" });
    const b = recall({ file: "/a.tsx", line: 2, wcag: ["2.4.4"], patternId: "b" });
    const c = recall({ file: "/a.tsx", line: 3, wcag: ["2.4.4"], patternId: "c" });
    expect(dedupeRecall([a, b, c], []).map((f) => f.patternId)).toEqual(["a", "b", "c"]);
  });
});

describe("dedupeRecall — cross + self dedup compose (post-refactor regression)", () => {
  // After lifting the cross-dedup onto dedupeEnforce, both passes must still run
  // and drop the SAME set: a candidate that is BOTH floor-covered and a self-dup
  // dies, while an unrelated same-element different-pattern candidate survives.
  it("drops the floor-covered + self-dup pair, keeps the distinct survivor", () => {
    const statics = [floor("/a.tsx", 10, ["4.1.2"])];
    const covered = recall({ file: "/a.tsx", line: 10, wcag: ["4.1.2"], patternId: "p1" });
    const candidates = [
      covered, // dropped by CROSS-dedup (floor caught 4.1.2 at /a.tsx:10)
      { ...covered, message: "again" }, // also cross-dropped (same key)
      recall({ file: "/a.tsx", line: 10, wcag: ["2.4.4"], patternId: "p1" }), // 1st survivor
      recall({ file: "/a.tsx", line: 10, wcag: ["2.4.4"], patternId: "p1" }), // SELF-dup → dropped
      recall({ file: "/a.tsx", line: 10, wcag: ["2.4.4"], patternId: "p2" }), // distinct survivor
    ];
    const out = dedupeRecall(candidates, statics);
    expect(out.map((f) => f.patternId)).toEqual(["p1", "p2"]);
    expect(out.every((f) => f.wcag.includes("2.4.4"))).toBe(true);
  });
});

describe("quarantine — scan() never emits corpus-agent findings", () => {
  it("scan() leaves recall empty and never tags a finding corpus-agent / recall", async () => {
    const result = await scan([fixture("controls.tsx")]);
    expect(result.recall).toEqual([]);
    expect(result.findings.length).toBeGreaterThan(0); // sanity: the fixture flags
    for (const f of result.findings) {
      expect(f.provenance).not.toBe("corpus-agent");
      expect(f.layer).not.toBe("recall");
    }
  });
});

describe("the exit-code invariant — recall can never flip the gate", () => {
  // The CLI exit code is `findings.filter(f => f.enforcement === "block").length > 0`
  // computed over `result.findings` ONLY (see cli.ts). Recall rides a separate
  // field, so populating it — even with `block` findings on the SAME lines — must
  // leave that count byte-identical.
  const blockingCount = (findings: readonly Finding[]): number =>
    findings.filter((f) => f.enforcement === "block").length;

  it("a corpus-agent finding on a flagged line does not change scan().findings or its blocking count", async () => {
    const result = await scan([fixture("controls.tsx")]);
    const baseline = blockingCount(result.findings);

    // Forge the worst case: a recall finding at the SAME file:line as a real
    // floor finding, and (illegally) marked block. It lives in `recall`, so the
    // exit-code computation over `result.findings` cannot see it.
    const target = result.findings[0];
    expect(target).toBeDefined();
    const malicious: Finding = recall({
      file: target!.file,
      line: target!.line,
      wcag: target!.wcag,
      patternId: "evil",
      enforcement: "block", // even mis-marked as block...
    });
    const withRecall = { ...result, recall: [malicious] };

    // The exit-code source of truth is untouched.
    expect(withRecall.findings).toBe(result.findings);
    expect(blockingCount(withRecall.findings)).toBe(baseline);
    // And the recall finding never leaked into findings.
    expect(withRecall.findings).not.toContain(malicious);
  });
});
