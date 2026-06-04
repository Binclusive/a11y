import { describe, expect, it } from "vitest";
import { corpusPatterns } from "../src/corpus";

const TIER_RANK: Record<string, number> = {
  "very-common": 0,
  common: 1,
  occasional: 2,
  unknown: 3,
};

describe("corpusPatterns: the real distilled moat", () => {
  const patterns = corpusPatterns();

  it("loads the full distilled set (51 patterns), deduped by id", () => {
    expect(patterns).toHaveLength(51);
    expect(new Set(patterns.map((p) => p.id)).size).toBe(patterns.length);
  });

  it("orders by frequency tier (very-common → common → occasional)", () => {
    for (let i = 1; i < patterns.length; i++) {
      expect(TIER_RANK[patterns[i].tier]).toBeGreaterThanOrEqual(TIER_RANK[patterns[i - 1].tier]);
    }
  });

  it("carries the per-shape signal: component + failureShape + fix", () => {
    const first = patterns[0];
    expect(first.component.length).toBeGreaterThan(0);
    expect(first.failureShape.length).toBeGreaterThan(0);
    expect(first.fix.length).toBeGreaterThan(0);
  });

  it("attaches each pattern's most-widespread SC and that SC's org aggregate", () => {
    // Every pattern has an SC; SCs present in the snapshot carry a numeric
    // aggregate (others are null but still listed).
    for (const p of patterns) {
      expect(p.sc).toMatch(/^\d+\.\d+\.\d+$/);
      expect(p.orgs === null || typeof p.orgs === "number").toBe(true);
    }
  });

  it("is pure — same call yields a structurally identical list", () => {
    expect(corpusPatterns()).toEqual(patterns);
  });
});
