import { describe, expect, it } from "vitest";
import { enrich } from "../src/evidence";
import type { Finding } from "../src/core";
import { formatSarif, severityToLevel } from "../src/sarif";
import { lineContentHash, resolveLocations } from "../src/source-identity";

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
    const f = enrich(raw({ provenance: "axe", file: "https://x.com/page", line: 0, severity: "serious" }));
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
      raw({ provenance: "axe", file: "https://x.com", line: 0, selector: "main", severity: "serious" }),
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
