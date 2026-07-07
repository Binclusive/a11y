import { describe, expect, it } from "vitest";
import { scFromTags } from "../src/collect-dom";

describe("scFromTags: axe WCAG tags → success criteria", () => {
  it("maps wcag111 → 1.1.1 and skips the conformance-level tag wcag2a", () => {
    expect(scFromTags(["wcag2a", "wcag111"])).toEqual(["1.1.1"]);
  });

  it("maps wcag244 → 2.4.4", () => {
    expect(scFromTags(["wcag244"])).toEqual(["2.4.4"]);
  });

  it("round-trips a multi-digit criterion: wcag1411 → 1.4.11", () => {
    expect(scFromTags(["wcag1411"])).toEqual(["1.4.11"]);
  });

  it("drops non-WCAG and lettered tags", () => {
    expect(scFromTags(["best-practice", "cat.color", "wcag21aa", "ACT"])).toEqual([]);
  });

  it("dedupes while preserving first-seen order", () => {
    expect(scFromTags(["wcag412", "wcag131", "wcag412"])).toEqual(["4.1.2", "1.3.1"]);
  });
});
