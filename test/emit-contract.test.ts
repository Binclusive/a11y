import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { Finding as ContractFinding, parseFindingPayload, Provenance, Severity } from "@binclusive/a11y-contract";
import { enrich } from "../src/evidence";
import type { Finding, FindingProvenance } from "../src/core";
import {
  contractSeverity,
  impactToSeverity,
  toContractFinding,
  toContractProvenance,
  toFindingPayload,
} from "../src/emit-contract";

/**
 * The wire projection (`localFinding -> contract`) is the "emit the contract"
 * path. These lock its two load-bearing guarantees: the output validates against
 * the canonical zod schema, and every source locator is dropped at the boundary.
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

const ALL_PROVENANCE: readonly FindingProvenance[] = [
  "jsx-a11y",
  "enforce",
  "axe",
  "swiftui",
  "liquid",
  "unity",
  "corpus-agent",
];

describe("provenance projection (7-value -> binary)", () => {
  it("maps every deterministic pass to `deterministic` and only corpus-agent to `agent`", () => {
    for (const p of ALL_PROVENANCE) {
      const expected = p === "corpus-agent" ? "agent" : "deterministic";
      expect(toContractProvenance(p)).toBe(expected);
      expect(() => Provenance.parse(toContractProvenance(p))).not.toThrow();
    }
  });
});

describe("severity projection (axe impact -> contract enum)", () => {
  it("collapses the 4-level axe impact onto critical|major|minor", () => {
    expect(impactToSeverity("critical")).toBe("critical");
    expect(impactToSeverity("serious")).toBe("major");
    expect(impactToSeverity("moderate")).toBe("major");
    expect(impactToSeverity("minor")).toBe("minor");
  });

  it("always yields a valid contract severity for any enriched finding", () => {
    const f = enrich(raw({ provenance: "axe", file: "https://x", line: 0, selector: "div", severity: "serious" }));
    expect(() => Severity.parse(contractSeverity(f))).not.toThrow();
  });
});

describe("toContractFinding narrows onto the metadata-only DTO", () => {
  it("drops every source locator (file / line / ruleId as keys)", () => {
    const projected = toContractFinding(enrich(raw()), "changed-files");
    expect(projected).not.toHaveProperty("file");
    expect(projected).not.toHaveProperty("line");
    expect(projected).not.toHaveProperty("ruleId");
    // A strict re-parse proves no foreign key survived.
    expect(() => ContractFinding.parse(projected)).not.toThrow();
  });

  it("element falls back to the rule id when there is no DOM selector", () => {
    const projected = toContractFinding(enrich(raw()), "s");
    expect(projected.element).toBe("jsx-a11y/alt-text");
  });

  it("element falls back to the rule id for an empty or whitespace-only selector", () => {
    for (const selector of ["", "   "]) {
      const f = enrich(raw({ provenance: "axe", file: "https://x", line: 0, selector }));
      const projected = toContractFinding(f, "s");
      expect(projected.element).toBe("jsx-a11y/alt-text");
      expect(projected.element).not.toBe("");
    }
  });

  it("element uses the axe selector when present", () => {
    const f = enrich(raw({ provenance: "axe", file: "https://x", line: 0, selector: "main > div.hero" }));
    const projected = toContractFinding(f, "s");
    expect(projected.element).toBe("main > div.hero");
  });

  it("the deterministic arm carries the required contract `tier` (a placeholder now) and no agent fields", () => {
    // ADR 0041 §G: the corpus left the engine, so `tier` is no longer corpus-derived.
    // The published `@binclusive/a11y-contract@0.1.1` still REQUIRES it as a string,
    // so the engine emits a frozen `"unknown"` placeholder until the parked
    // contract-field removal (Can's OTP) drops the field and this constant together.
    const projected = toContractFinding(enrich(raw()), "s");
    expect(projected.provenance).toBe("deterministic");
    if (projected.provenance === "deterministic") {
      expect(typeof projected.tier).toBe("string");
      expect(projected.tier).toBe("unknown");
    }
    expect(projected).not.toHaveProperty("rationale");
  });

  it("the agent arm carries a rationale and no `tier`", () => {
    const f = enrich(raw({ provenance: "corpus-agent", layer: "recall", patternId: "p1", enforcement: "warn" }));
    const projected = toContractFinding(f, "s");
    expect(projected.provenance).toBe("agent");
    expect(projected).not.toHaveProperty("tier");
    if (projected.provenance === "agent") {
      expect(projected.rationale.length).toBeGreaterThan(0);
    }
  });
});

describe("toFindingPayload — the emit boundary", () => {
  it("produces a payload that validates against the canonical schema", () => {
    const findings = [
      enrich(raw()),
      enrich(raw({ provenance: "axe", file: "https://x", line: 0, selector: "a.link", severity: "critical", wcag: ["1.4.3"] })),
      enrich(raw({ provenance: "corpus-agent", layer: "recall", patternId: "p1", wcag: ["2.4.4"] })),
    ];
    const payload = toFindingPayload(findings, "pr-1291");
    // toFindingPayload re-parses internally; a second parse confirms round-trip.
    expect(() => parseFindingPayload(payload)).not.toThrow();
    expect(payload.findings.map((f) => f.provenance)).toEqual(["deterministic", "deterministic", "agent"]);
    expect(payload.findings.every((f) => f.scope === "pr-1291")).toBe(true);
  });

  it("never throws and always drops file/line for any provenance", () => {
    fc.assert(
      fc.property(fc.constantFrom(...ALL_PROVENANCE), fc.string(), (provenance, scope) => {
        const payload = toFindingPayload([enrich(raw({ provenance }))], scope);
        const [f] = payload.findings;
        expect(f).not.toHaveProperty("file");
        expect(f).not.toHaveProperty("line");
      }),
    );
  });
});
