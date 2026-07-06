import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { buildBaselineCatalog } from "../src/baseline/gen-baseline";
import { detailLines } from "../src/cli";
import {
  baselineRules,
  evidenceBestPractice,
  evidenceFix,
  evidenceHelpUrl,
  evidenceSeverity,
  enrich,
  resolveDisplay,
} from "../src/evidence";
import type { Finding } from "../src/core";

/**
 * A minimal axe finding for the baseline path. Defaults to
 * `color-contrast-enhanced` (SC 1.4.6), so enrich() resolves it to
 * `source:"baseline"` off axe's published per-rule catalog.
 */
function axeFinding(over: Partial<Finding>): Finding {
  return {
    file: "https://example.com",
    line: 0,
    ruleId: "color-contrast-enhanced",
    message: "Elements must meet enhanced color contrast ratio thresholds",
    wcag: ["1.4.6"],
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

  it("carries NO org count and NO frequency tier (coverage data, not audit)", () => {
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
  it("answers from the axe catalog for any SC (1.4.3 color-contrast)", () => {
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

describe("enrich: baseline coverage, never a dead end (ADR 0041 §G — pure detection)", () => {
  it("resolves an axe finding to baseline by SC, carrying severity + fix + helpUrl", () => {
    const e = enrich(axeFinding({ severity: undefined }));
    expect(e.corpus.source).toBe("baseline");
    if (e.corpus.source !== "baseline") throw new Error("unreachable");
    expect(e.corpus.sc).toBe("1.4.6");
    // No frequency tier / org count is carried anywhere — the engine is pure
    // detection; frequency is platform-derived (ADR 0041 §G).
    expect("tier" in e.corpus).toBe(false);
    expect("orgs" in e.corpus).toBe(false);
    expect(e.corpus.severity).toBe("serious"); // axe's published default impact
    expect(e.corpus.fix).not.toBeNull();
    expect(e.corpus.helpUrl).toContain("dequeuniversity.com");
  });

  it("prefers the axe runtime impact over the baseline default severity", () => {
    const e = enrich(axeFinding({ severity: "critical" }));
    expect(e.corpus.source).toBe("baseline");
    expect(evidenceSeverity(e)).toBe("critical"); // runtime impact wins
  });

  it("baseline-matches a source-pass finding by SC (no axe ruleId)", () => {
    const e = enrich({
      file: "/x.tsx",
      line: 5,
      ruleId: "jsx-a11y/some-rule",
      message: "x",
      wcag: ["1.4.6"],
      enforcement: "warn",
      provenance: "jsx-a11y",
    });
    expect(e.corpus.source).toBe("baseline");
    expect(evidenceSeverity(e)).toBe("serious");
    expect(evidenceHelpUrl(e)).toContain("dequeuniversity.com");
  });

  it("resolves any WCAG-tagged source finding to baseline (e.g. 2.4.4)", () => {
    const e = enrich({
      file: "/x.tsx",
      line: 3,
      ruleId: "jsx-a11y/anchor-has-content",
      message: "Anchors must have content",
      wcag: ["2.4.4"],
      enforcement: "block",
      provenance: "jsx-a11y",
    });
    expect(e.corpus.source).toBe("baseline");
    if (e.corpus.source !== "baseline") throw new Error("unreachable");
    expect(e.corpus.sc).toBe("2.4.4");
    expect(e.corpus.fix).not.toBeNull();
    expect(evidenceBestPractice(e.corpus)).toBe(false);
  });

  it("falls back to baseline-by-ruleId for an axe best-practice rule with no SC", () => {
    // `region` is a real axe best-practice rule carrying NO WCAG SC tag.
    const e = enrich(
      axeFinding({
        ruleId: "region",
        wcag: [], // best-practice rules emit no wcag tag → no SC to key on
        message: "All page content should be contained by landmarks",
        severity: undefined,
      }),
    );
    expect(e.corpus.source).toBe("baseline");
    if (e.corpus.source !== "baseline") throw new Error("unreachable");
    expect(e.corpus.bestPractice).toBe(true);
    expect(e.corpus.sc).toBeNull(); // honest: not a WCAG failure
    expect(e.corpus.severity).toBe("moderate"); // axe's published default impact
    expect(e.corpus.fix).not.toBeNull();
    expect(e.corpus.helpUrl).toContain("dequeuniversity.com");
  });

  it("best-practice by-ruleId still lets axe runtime impact win", () => {
    const e = enrich(
      axeFinding({ ruleId: "landmark-unique", wcag: [], severity: "serious" }),
    );
    expect(e.corpus.source).toBe("baseline");
    expect(evidenceBestPractice(e.corpus)).toBe(true);
    expect(evidenceSeverity(e)).toBe("serious"); // runtime impact over catalog default
  });

  it("returns source 'none' only when the ruleId is absent from the catalog", () => {
    const e = enrich({
      file: "/x.tsx",
      line: 1,
      ruleId: "jsx-a11y/unmapped", // not an axe rule — not in the catalog
      message: "x",
      wcag: ["9.9.9"], // not a real SC; in neither source
      enforcement: "warn",
      provenance: "jsx-a11y",
    });
    expect(e.corpus.source).toBe("none");
    // The `none` variant carries NO catalog evidence at all — the union has only
    // its `source` tag; severity/helpUrl come off the finding via the accessors.
    expect(Object.keys(e.corpus)).toEqual(["source"]);
    expect(evidenceSeverity(e)).toBeNull();
    expect(evidenceBestPractice(e.corpus)).toBe(false);
  });
});

describe("rule-accurate fix: axe findings show axe guidance, source findings show the baseline fix", () => {
  // `aria-progressbar-name` is an axe rule tagged WCAG 1.1.1. axe's per-rule help
  // is rule-accurate, so the DISPLAYED fix for an axe finding must be axe's own
  // message — never the SC-keyed baseline fix (which is written for the SC's
  // most-common failure and would contradict the rule).
  const progressbar = (over: Partial<Finding> = {}): Finding =>
    axeFinding({
      ruleId: "aria-progressbar-name",
      message: "ARIA progressbar nodes must have an accessible name",
      wcag: ["1.1.1"],
      severity: "serious",
      helpUrl:
        "https://dequeuniversity.com/rules/axe/4.11/aria-progressbar-name?application=axeAPI",
      ...over,
    });

  it("enriches to baseline on SC 1.1.1, carrying axe's severity + help", () => {
    const e = enrich(progressbar());
    expect(e.corpus.source).toBe("baseline");
    if (e.corpus.source !== "baseline") throw new Error("unreachable");
    expect(e.corpus.sc).toBe("1.1.1");
    expect(evidenceSeverity(e)).toBe("serious");
  });

  it("resolveDisplay.fix returns axe's rule guidance for an axe finding", () => {
    const e = enrich(progressbar());
    const fix = resolveDisplay(e).fix;
    expect(fix).toBe("ARIA progressbar nodes must have an accessible name");
    // The CLI suppresses the `fix:` line for axe findings in favour of `ref`.
    expect(resolveDisplay(e).fixLine).toBe(evidenceFix(e.corpus));
  });

  it("the rendered axe finding shows a Deque ref + severity, no contradictory audit tier", () => {
    const lines = detailLines(enrich(progressbar()));
    const text = lines.join("\n");
    // No corpus/frequency tier line survives (ADR 0041 §G).
    expect(text).not.toMatch(/corpus:/);
    expect(text).not.toMatch(/orgs/);
    // The canonical per-rule fix page is linked and axe's own message shown.
    expect(text).toContain(
      "ref:    https://dequeuniversity.com/rules/axe/4.11/aria-progressbar-name?application=axeAPI",
    );
    expect(text).toContain("ARIA progressbar nodes must have an accessible name");
    expect(text).toContain("severity: SERIOUS");
    // The coverage annotation replaces the old corpus line.
    expect(text).toContain("coverage: axe baseline rule SC 1.1.1");
  });

  it("a SOURCE-PASS finding on the same SC shows the baseline fix verbatim", () => {
    const e = enrich({
      file: "/x.tsx",
      line: 7,
      ruleId: "jsx-a11y/alt-text",
      message: "img elements must have an alt prop",
      wcag: ["1.1.1"],
      enforcement: "block",
      provenance: "jsx-a11y",
    });
    expect(e.corpus.source).toBe("baseline");
    if (e.corpus.source !== "baseline") throw new Error("unreachable");
    // A source finding shows the SC-keyed baseline fix (axe's per-rule help).
    expect(resolveDisplay(e).fix).toBe(evidenceFix(e.corpus));
    expect(resolveDisplay(e).fix).toBe(e.corpus.fix);

    const text = detailLines(e).join("\n");
    expect(text).toContain("coverage: axe baseline rule SC 1.1.1");
    expect(text).toMatch(/fix:\s+/); // baseline fix still rendered for source findings
  });
});
