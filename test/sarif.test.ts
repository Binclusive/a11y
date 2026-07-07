import { describe, expect, it } from "vitest";
import { enrich, resolveDisplay } from "../src/evidence";
import type { Finding } from "../src/core";
import { formatSarif, impactToLevel } from "../src/sarif";
import { lineContentHash, resolveLocations } from "../src/source-identity";

/**
 * SARIF is a LOCAL renderer: it reads the rich source-anchored finding (needs
 * file/line for physical locations) and narrows the finding's impact through the
 * ONE contract-impact mapping (`impactToLevel`) — never through the metadata-only
 * wire projection.
 */

const raw = (over: Partial<Finding> = {}): Finding => ({
  file: "src/Button.tsx",
  line: 12,
  ruleId: "jsx-a11y/alt-text",
  message: "img is missing an alt attribute",
  wcag: ["1.1.1"],
  enforcement: "block",
  provenance: "jsx-a11y",
  ...over,
});

describe("impactToLevel (contract impact enum -> SARIF level)", () => {
  it("maps the closed impact enum onto error|warning|note", () => {
    expect(impactToLevel("critical")).toBe("error");
    expect(impactToLevel("serious")).toBe("error");
    expect(impactToLevel("moderate")).toBe("warning");
    expect(impactToLevel("minor")).toBe("note");
    expect(impactToLevel("unknown")).toBe("note");
  });
});

describe("formatSarif over the local finding", () => {
  it("emits a valid SARIF 2.1.0 shell with one run", () => {
    const sarif = JSON.parse(formatSarif([enrich(raw())], "pr-7"));
    expect(sarif.version).toBe("2.1.0");
    expect(sarif.runs).toHaveLength(1);
    expect(sarif.runs[0].automationDetails.id).toBe("binclusive-a11y/pr-7");
  });

  it("anchors a source finding on its file + line via physicalLocation.region", () => {
    const sarif = JSON.parse(formatSarif([enrich(raw({ file: "src/Nav.tsx", line: 42 }))], "r"));
    const loc = sarif.runs[0].results[0].locations[0];
    expect(loc.physicalLocation.artifactLocation.uri).toBe("src/Nav.tsx");
    expect(loc.physicalLocation.region.startLine).toBe(42);
  });

  it("anchors a rendered-DOM (axe) finding on its selector as a logicalLocation, no region", () => {
    const f = enrich(raw({ provenance: "axe", file: "https://x.com", line: 0, selector: "main div.hero", impact: "serious" }));
    const loc = JSON.parse(formatSarif([f], "r")).runs[0].results[0].locations[0];
    expect(loc.physicalLocation.artifactLocation.uri).toBe("https://x.com");
    expect(loc.physicalLocation.region).toBeUndefined();
    expect(loc.logicalLocations[0].fullyQualifiedName).toBe("main div.hero");
  });

  it("levels a result through the contract impact mapping (serious axe impact -> error)", () => {
    const f = enrich(raw({ provenance: "axe", file: "https://x", line: 0, impact: "serious" }));
    expect(JSON.parse(formatSarif([f], "r")).runs[0].results[0].level).toBe("error");
  });

  it("levels a moderate axe impact as a SARIF warning", () => {
    const f = enrich(raw({ provenance: "axe", file: "https://x", line: 0, impact: "moderate" }));
    expect(JSON.parse(formatSarif([f], "r")).runs[0].results[0].level).toBe("warning");
  });

  it("dedups the rule list by ruleId", () => {
    const sarif = JSON.parse(formatSarif([enrich(raw({ line: 1 })), enrich(raw({ line: 2 }))], "r"));
    expect(sarif.runs[0].tool.driver.rules).toHaveLength(1);
    expect(sarif.runs[0].results).toHaveLength(2);
  });

  it("tags each result with its provenance so deterministic vs agent stays distinguishable", () => {
    const floor = JSON.parse(formatSarif([enrich(raw())], "r"));
    expect(floor.runs[0].results[0].properties.provenance).toBe("deterministic");
    const agent = JSON.parse(formatSarif([enrich(raw({ provenance: "corpus-agent" }))], "r"));
    expect(agent.runs[0].results[0].properties.provenance).toBe("agent");
  });

  it("relativizes a source-file uri against the scanned root (repo-relative for code-scanning)", () => {
    const f = enrich(raw({ file: "/work/stage/src/Nav.tsx", line: 5 }));
    const sarif = JSON.parse(formatSarif([f], "r", { root: "/work/stage" }));
    expect(sarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri).toBe("src/Nav.tsx");
  });

  it("leaves a rendered-DOM URL uri untouched even when a root is given", () => {
    const f = enrich(raw({ provenance: "axe", file: "https://x.com/page", line: 0, impact: "serious" }));
    const sarif = JSON.parse(formatSarif([f], "r", { root: "/work/stage" }));
    expect(sarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri).toBe("https://x.com/page");
  });
});

describe("partialFingerprints.primaryLocationLineHash (code-scanning alert tracking, ADR 0042)", () => {
  // Inject the offending line's content so the hash is deterministic without a real
  // file on disk — the SARIF renderer resolves identity through the same lineSource.
  const lineAt = (content: string, line: number) => ({
    lineSource: () => Array.from({ length: line }, (_, i) => (i === line - 1 ? content : "")),
  });

  it("carries a source finding's line-content hash (with the identity index) as the fingerprint", () => {
    const content = '  <img src="hero.png" />';
    const f = enrich(raw({ file: "src/Nav.tsx", line: 3 }));
    const result = JSON.parse(formatSarif([f], "r", lineAt(content, 3))).runs[0].results[0];
    expect(result.partialFingerprints.primaryLocationLineHash).toBe(`${lineContentHash(content)}:0`);
  });

  it("is the SAME hash the wire finding identity resolves — SARIF and identity can't disagree", () => {
    const f = enrich(raw({ file: "src/Nav.tsx", line: 3 }));
    const opts = lineAt('  <label htmlFor="x" />', 3);
    const identity = resolveLocations([f], opts).get(f);
    if (identity?.kind !== "source") throw new Error("expected a source location");
    const fp = JSON.parse(formatSarif([f], "r", opts)).runs[0].results[0].partialFingerprints
      .primaryLocationLineHash;
    expect(fp).toBe(`${identity.lineHash}:${identity.index}`);
  });

  it("disambiguates two findings with identical line content by index (:0 then :1, ordered by source line)", () => {
    const content = "<td></td>";
    // line 5 and line 10 share (path, lineHash); index is assigned by ascending line,
    // so the emit order below (line 10 first) must NOT decide the index.
    const opts = {
      lineSource: () => Array.from({ length: 10 }, (_, i) => (i === 4 || i === 9 ? content : "")),
    };
    const fs = [
      enrich(raw({ file: "src/Grid.tsx", line: 10 })),
      enrich(raw({ file: "src/Grid.tsx", line: 5 })),
    ];
    const results = JSON.parse(formatSarif(fs, "r", opts)).runs[0].results;
    const h = lineContentHash(content);
    const prints = results.map((r) => r.partialFingerprints.primaryLocationLineHash);
    expect(new Set(prints)).toEqual(new Set([`${h}:0`, `${h}:1`]));
  });

  it("does NOT fabricate a fingerprint for a rendered-DOM (page) finding", () => {
    const f = enrich(
      raw({ provenance: "axe", file: "https://x.com", line: 0, selector: "main", impact: "serious" }),
    );
    const result = JSON.parse(formatSarif([f], "r")).runs[0].results[0];
    expect(result.partialFingerprints).toBeUndefined();
  });

  it("stays valid SARIF 2.1.0 — the fingerprint is purely additive", () => {
    const sarif = JSON.parse(formatSarif([enrich(raw())], "pr-1"));
    expect(sarif.version).toBe("2.1.0");
    expect(sarif.runs).toHaveLength(1);
    expect(sarif.runs[0].results[0].locations).toHaveLength(1);
  });
});

/**
 * Agent-DX enrichment (#2339). The renderer invests in the fields Copilot Autofix
 * actually reads to GENERATE a fix — rule `help`/`fullDescription`, a specific
 * `result.message`, and `relatedLocations` — and deliberately never emits
 * `fixes[]`: Autofix ignores it, and a schema-valid fix requires fabricated
 * `artifactChanges`, which would violate suggestions-not-patches. The fix prose is
 * single-sourced through {@link resolveDisplay} (axe → the per-node message;
 * source → the SC-keyed baseline fix), so text and SARIF can never disagree.
 */
describe("agent-DX: rule help / fullDescription — the Autofix lever (#2339)", () => {
  it("carries the finding's fix prose in BOTH help and fullDescription (what Autofix reads)", () => {
    const f = enrich(raw());
    const fix = resolveDisplay(f).fix;
    expect(fix).not.toBeNull(); // alt-text (SC 1.1.1) resolves to a baseline fix
    const rule = JSON.parse(formatSarif([f], "r")).runs[0].tool.driver.rules[0];
    expect(rule.help.text).toBe(fix);
    expect(rule.fullDescription.text).toBe(fix);
    // shortDescription stays the finding message — the enrichment is additive.
    expect(rule.shortDescription.text).toBe(f.message);
  });

  it("draws an axe finding's rule help from its per-node message (resolveDisplay axe policy)", () => {
    const f = enrich(raw({ provenance: "axe", file: "https://x.com", line: 0, message: "Contrast is too low", impact: "serious" }));
    const rule = JSON.parse(formatSarif([f], "r")).runs[0].tool.driver.rules[0];
    expect(rule.help.text).toBe("Contrast is too low");
    expect(rule.fullDescription.text).toBe("Contrast is too low");
  });

  it('omits help/fullDescription when the finding resolves to no fix prose (never emits "")', () => {
    // No WCAG SC and a non-catalog rule id → no baseline evidence → fix is null.
    const f = enrich(raw({ ruleId: "jsx-a11y/no-such-rule", wcag: [] }));
    expect(resolveDisplay(f).fix).toBeNull();
    const rule = JSON.parse(formatSarif([f], "r")).runs[0].tool.driver.rules[0];
    expect(rule.help).toBeUndefined();
    expect(rule.fullDescription).toBeUndefined();
  });
});

describe("agent-DX: result.message carries the rationale/suggestion (#2339)", () => {
  it("uses the finding message verbatim when there is no agent enrichment", () => {
    const result = JSON.parse(formatSarif([enrich(raw())], "r")).runs[0].results[0];
    expect(result.message.text).toBe("img is missing an alt attribute");
  });

  it("folds an enriched deterministic finding's agentNote into the SARIF message", () => {
    // A discovery already folds its rationale into `message`; an enriched
    // deterministic finding carries the suggestion in `agentNote` — append it so
    // the SARIF message carries the agent's reasoning either way.
    const f = enrich(raw({ agentNote: "Use the product name as the alt text." }));
    const result = JSON.parse(formatSarif([f], "r")).runs[0].results[0];
    expect(result.message.text).toBe("img is missing an alt attribute Use the product name as the alt text.");
  });
});

describe("agent-DX: relatedLocations for a distinct second node (#2339)", () => {
  it("surfaces the rendered element as a related location when a SOURCE finding names one", () => {
    // A corpus-agent discovery grounded in a source line (line > 0) that also
    // names an element: the code line is the site, the element is context.
    const f = enrich(raw({ provenance: "corpus-agent", file: "src/Nav.tsx", line: 5, selector: "nav > a.brand" }));
    const result = JSON.parse(formatSarif([f], "r")).runs[0].results[0];
    expect(result.relatedLocations).toHaveLength(1);
    expect(result.relatedLocations[0].logicalLocations[0]).toEqual({ fullyQualifiedName: "nav > a.brand", kind: "element" });
    expect(result.relatedLocations[0].message.text).toContain("nav > a.brand");
    // Nothing links to it → no id (canon §3.28.2); it is context, so it carries
    // no physicalLocation and never usurps the primary site (§3.27.22).
    expect(result.relatedLocations[0].id).toBeUndefined();
    expect(result.relatedLocations[0].physicalLocation).toBeUndefined();
    // The primary stays the code region; the selector is NOT a primary logicalLocation.
    expect(result.locations[0].physicalLocation.region.startLine).toBe(5);
    expect(result.locations[0].logicalLocations).toBeUndefined();
  });

  it("is graceful-empty (omitted) for a source finding with no rendered node", () => {
    const result = JSON.parse(formatSarif([enrich(raw())], "r")).runs[0].results[0];
    expect(result.relatedLocations).toBeUndefined();
  });

  it("keeps an axe (page) finding's selector on the PRIMARY node, never in relatedLocations", () => {
    const f = enrich(raw({ provenance: "axe", file: "https://x.com", line: 0, selector: "button.cta", impact: "serious" }));
    const result = JSON.parse(formatSarif([f], "r")).runs[0].results[0];
    expect(result.relatedLocations).toBeUndefined();
    expect(result.locations[0].logicalLocations[0]).toEqual({ fullyQualifiedName: "button.cta", kind: "element" });
  });
});

describe("agent-DX: never emits fixes[] (#2339 corrected scope)", () => {
  // A SARIF `fix` REQUIRES `artifactChanges` — a concrete code edit. A prose-only
  // fix is schema-invalid, and Autofix ignores `fixes[]` regardless. Emitting one
  // means fabricating edits — the exact thing suggestions-not-patches forbids.
  it("emits no fixes[] (and no artifactChanges) anywhere, across every finding shape", () => {
    const json = formatSarif(
      [
        enrich(raw()),
        enrich(raw({ provenance: "corpus-agent", file: "src/Nav.tsx", line: 5, selector: "a.brand" })),
        enrich(raw({ provenance: "axe", file: "https://x.com", line: 0, selector: "button", impact: "serious" })),
      ],
      "r",
    );
    for (const result of JSON.parse(json).runs[0].results) {
      expect(result.fixes).toBeUndefined();
    }
    expect(json).not.toMatch(/"fixes"/);
    expect(json).not.toMatch(/artifactChanges/);
  });
});
