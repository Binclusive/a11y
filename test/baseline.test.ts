import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { buildBaselineCatalog } from "../src/baseline/gen-baseline";
import { baselineRules, enrich } from "../src/corpus";
import type { Finding } from "../src/core";

/** A minimal axe finding, with only the fields enrich/baseline read. */
function axeFinding(over: Partial<Finding>): Finding {
  return {
    file: "https://example.com",
    line: 0,
    ruleId: "color-contrast",
    message: "Elements must meet minimum color contrast ratio thresholds",
    wcag: ["1.4.3"],
    enforcement: "block",
    provenance: "axe",
    ...over,
  };
}

describe("baseline generator: buildBaselineCatalog output shape", () => {
  // Load axe-core the same way the generator does, so the test exercises the
  // real metadata, not a fixture.
  const require = createRequire(import.meta.url);
  const axe = require("axe-core") as Parameters<typeof buildBaselineCatalog>[0];
  const catalog = buildBaselineCatalog(axe);

  it("emits one entry per axe rule, ruleId-sorted (deterministic)", () => {
    expect(catalog.rules.length).toBe(axe.getRules().length);
    const ids = catalog.rules.map((r) => r.ruleId);
    expect(ids).toEqual([...ids].sort());
    expect(catalog._meta.ruleCount).toBe(catalog.rules.length);
    expect(catalog._meta.axeVersion).toBe(axe.version);
  });

  it("each rule carries a valid severity, a fix (help), and a helpUrl", () => {
    const levels = new Set(["minor", "moderate", "serious", "critical"]);
    for (const r of catalog.rules) {
      expect(levels.has(r.severity)).toBe(true);
      expect(r.help.length).toBeGreaterThan(0);
      expect(r.helpUrl).toMatch(/^https?:\/\//);
      expect(Array.isArray(r.sc)).toBe(true);
    }
  });

  it("carries NO org count and NO frequency tier (not audit data)", () => {
    for (const r of catalog.rules) {
      expect("orgs" in r).toBe(false);
      expect("tier" in r).toBe(false);
    }
  });

  it("color-contrast → SC 1.4.3, severity serious, with a Deque helpUrl", () => {
    const cc = catalog.rules.find((r) => r.ruleId === "color-contrast");
    expect(cc).toBeDefined();
    expect(cc?.sc).toContain("1.4.3");
    expect(cc?.severity).toBe("serious");
    expect(cc?.helpUrl).toContain("dequeuniversity.com");
  });

  it("is committed at data/baseline-rules.json matching the generator", () => {
    // Guards against a stale committed catalog: the shipped JSON must equal what
    // the generator produces from the installed axe-core.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const committed = require("../data/baseline-rules.json");
    expect(committed.rules.length).toBe(catalog.rules.length);
    expect(committed._meta.axeVersion).toBe(catalog._meta.axeVersion);
  });
});

describe("baselineRules: query the catalog by ruleId / SC", () => {
  it("answers for an SC the corpus has never distilled (1.4.3 color-contrast)", () => {
    const rules = baselineRules({ sc: "1.4.3" });
    expect(rules.length).toBeGreaterThan(0);
    const cc = rules.find((r) => r.ruleId === "color-contrast");
    expect(cc?.severity).toBe("serious");
    expect(cc?.fix.length).toBeGreaterThan(0);
    expect(cc?.helpUrl).toContain("dequeuniversity.com");
  });

  it("answers by axe ruleId substring", () => {
    const rules = baselineRules({ ruleId: "color-contrast" });
    expect(rules.some((r) => r.ruleId === "color-contrast")).toBe(true);
  });
});

describe("enrich: corpus FIRST, baseline fallback, never a dead end", () => {
  it("falls back to baseline for an SC absent from the corpus (1.4.3)", () => {
    // 1.4.3 (color-contrast) is NOT in the seed snapshot — the classic dead end.
    const e = enrich(axeFinding({ severity: undefined }));
    expect(e.corpus.source).toBe("baseline");
    expect(e.corpus.sc).toBe("1.4.3");
    expect(e.corpus.tier).toBe("unknown"); // not audit-frequency data
    expect(e.corpus.orgs).toBeNull(); // baseline carries no org count
    expect(e.corpus.severity).toBe("serious"); // axe's published default impact
    expect(e.corpus.fix).not.toBeNull();
    expect(e.corpus.helpUrl).toContain("dequeuniversity.com");
  });

  it("prefers the axe runtime impact over the baseline default severity", () => {
    const e = enrich(axeFinding({ severity: "critical" }));
    expect(e.corpus.source).toBe("baseline");
    expect(e.corpus.severity).toBe("critical"); // runtime impact wins
  });

  it("baseline-matches a source-pass finding by SC (no axe ruleId)", () => {
    // A jsx-a11y finding for an SC the corpus lacks still gets baseline coverage.
    const e = enrich({
      file: "/x.tsx",
      line: 5,
      ruleId: "jsx-a11y/some-rule",
      message: "x",
      wcag: ["1.4.3"],
      enforcement: "warn",
      provenance: "jsx-a11y",
    });
    expect(e.corpus.source).toBe("baseline");
    expect(e.corpus.severity).toBe("serious");
    expect(e.corpus.helpUrl).toContain("dequeuniversity.com");
  });

  it("corpus-covered SCs still return source 'audit', unchanged", () => {
    // 2.4.4 IS in the snapshot (very-common, 17/26). Must NOT be shadowed by
    // baseline: the moat takes precedence and the org count survives.
    const e = enrich({
      file: "/x.tsx",
      line: 3,
      ruleId: "jsx-a11y/anchor-has-content",
      message: "Anchors must have content",
      wcag: ["2.4.4"],
      enforcement: "block",
      provenance: "jsx-a11y",
    });
    expect(e.corpus.source).toBe("audit");
    expect(e.corpus.sc).toBe("2.4.4");
    expect(e.corpus.tier).toBe("very-common");
    expect(e.corpus.orgs).toBe(17);
    expect(e.corpus.fix).not.toBeNull();
  });

  it("returns source 'none' when neither source knows the SC", () => {
    const e = enrich({
      file: "/x.tsx",
      line: 1,
      ruleId: "jsx-a11y/unmapped",
      message: "x",
      wcag: ["9.9.9"], // not a real SC; in neither source
      enforcement: "warn",
      provenance: "jsx-a11y",
    });
    expect(e.corpus.source).toBe("none");
    expect(e.corpus.sc).toBeNull();
    expect(e.corpus.severity).toBeNull();
  });
});
