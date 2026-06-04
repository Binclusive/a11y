import { describe, expect, it } from "vitest";
import { compareSC, normalizeCriterion } from "../../src/distill/normalize-sc";

describe("normalizeCriterion", () => {
  it("passes through a bare SC", () => {
    expect(normalizeCriterion("4.1.2")).toEqual(["4.1.2"]);
    expect(normalizeCriterion("1.3.1")).toEqual(["1.3.1"]);
  });

  it("strips a WCAG prefix", () => {
    expect(normalizeCriterion("WCAG 2.4.4")).toEqual(["2.4.4"]);
  });

  it("expands the smushed wcagNNN form", () => {
    expect(normalizeCriterion("wcag244")).toEqual(["2.4.4"]);
    expect(normalizeCriterion("wcag246")).toEqual(["2.4.6"]);
  });

  it("strips a trailing label after the SC number", () => {
    expect(normalizeCriterion("2.1.1 Keyboard")).toEqual(["2.1.1"]);
    expect(normalizeCriterion("2.4.1 Bypass Blocks")).toEqual(["2.4.1"]);
    expect(normalizeCriterion("2.4.3 Focus Order")).toEqual(["2.4.3"]);
  });

  it("expands multi-code blobs to each SC, sorted and de-duped", () => {
    expect(normalizeCriterion("4.1.2, 3.3.2")).toEqual(["3.3.2", "4.1.2"]);
    expect(normalizeCriterion("4.1.2, 2.1.1")).toEqual(["2.1.1", "4.1.2"]);
    expect(normalizeCriterion("1.3.1, 1.3.2, 4.1.1")).toEqual(["1.3.1", "1.3.2", "4.1.1"]);
    expect(normalizeCriterion("4.1.2, 4.1.2")).toEqual(["4.1.2"]);
  });

  it("maps axe rule-ids via the lookup table", () => {
    expect(normalizeCriterion("heading-order")).toEqual(["1.3.1"]);
    expect(normalizeCriterion("link-name")).toEqual(["2.4.4"]);
    expect(normalizeCriterion("image-alt")).toEqual(["1.1.1"]);
    expect(normalizeCriterion("landmark-one-main")).toEqual(["1.3.1"]);
    expect(normalizeCriterion("aria-allowed-attr")).toEqual(["4.1.2"]);
    expect(normalizeCriterion("keyboard-operable")).toEqual(["2.1.1"]);
  });

  it("expands an axe rule-id that maps to multiple SC", () => {
    expect(normalizeCriterion("label-title-only")).toEqual(["3.3.2", "4.1.2"]);
  });

  it("handles a two-part SC like 2.4.11", () => {
    expect(normalizeCriterion("2.4.11")).toEqual(["2.4.11"]);
  });

  it("returns [] for junk / unmappable values", () => {
    expect(normalizeCriterion("site-inaccessible")).toEqual([]);
    expect(normalizeCriterion("site-unreachable")).toEqual([]);
    expect(normalizeCriterion("asd")).toEqual([]);
    expect(normalizeCriterion("")).toEqual([]);
    expect(normalizeCriterion(null)).toEqual([]);
    expect(normalizeCriterion(undefined)).toEqual([]);
  });
});

describe("compareSC", () => {
  it("orders numerically, not lexically", () => {
    const sorted = ["1.3.10", "1.3.1", "2.1.1", "1.3.2"].sort(compareSC);
    expect(sorted).toEqual(["1.3.1", "1.3.2", "1.3.10", "2.1.1"]);
  });
});
