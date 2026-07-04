import { describe, expect, it } from "vitest";
import { enrich } from "../src/corpus";
import type { Finding } from "../src/core";
import { formatSarif, severityToLevel } from "../src/sarif";

/**
 * SARIF is a LOCAL renderer: it reads the rich source-anchored finding (needs
 * file/line for physical locations) and narrows severity through the ONE
 * contract-severity mapping (`severityToLevel`) — never through the metadata-only
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

describe("severityToLevel (contract enum -> SARIF level)", () => {
  it("maps the closed severity enum onto error|warning|note", () => {
    expect(severityToLevel("critical")).toBe("error");
    expect(severityToLevel("major")).toBe("warning");
    expect(severityToLevel("minor")).toBe("note");
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
    const f = enrich(raw({ provenance: "axe", file: "https://x.com", line: 0, selector: "main div.hero", severity: "serious" }));
    const loc = JSON.parse(formatSarif([f], "r")).runs[0].results[0].locations[0];
    expect(loc.physicalLocation.artifactLocation.uri).toBe("https://x.com");
    expect(loc.physicalLocation.region).toBeUndefined();
    expect(loc.logicalLocations[0].fullyQualifiedName).toBe("main div.hero");
  });

  it("levels a result through the contract severity mapping (serious axe impact -> warning)", () => {
    const f = enrich(raw({ provenance: "axe", file: "https://x", line: 0, severity: "serious" }));
    expect(JSON.parse(formatSarif([f], "r")).runs[0].results[0].level).toBe("warning");
  });

  it("dedups the rule list by ruleId", () => {
    const sarif = JSON.parse(formatSarif([enrich(raw({ line: 1 })), enrich(raw({ line: 2 }))], "r"));
    expect(sarif.runs[0].tool.driver.rules).toHaveLength(1);
    expect(sarif.runs[0].results).toHaveLength(2);
  });
});
