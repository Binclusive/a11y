import { describe, expect, it } from "vitest";
import { enrich } from "../../../src/corpus";
import type { Finding } from "../../../src/index";
import { FIX_TYPES, frameworkGuidanceFor, REACT_GUIDANCE } from "../../../src/runner";

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

describe("react guidance — the ported reasoning core", () => {
  it("carries the five ported checklist areas", () => {
    const titles = REACT_GUIDANCE.checklist.map((a) => a.title);
    expect(titles).toEqual([
      "Framework-Specific Areas",
      "High-Risk React Patterns",
      "React / Next.js Table Checks",
      "Next.js Checks",
      "Runtime-Only Checks",
    ]);
    for (const area of REACT_GUIDANCE.checklist) expect(area.items.length).toBeGreaterThan(0);
  });

  it("carries the four seed patterns, each fully populated with a valid fix type", () => {
    expect(REACT_GUIDANCE.patterns.map((p) => p.id)).toEqual([
      "PATTERN-REACT-001",
      "PATTERN-REACT-002",
      "PATTERN-REACT-003",
      "PATTERN-REACT-004",
    ]);
    for (const p of REACT_GUIDANCE.patterns) {
      expect(p.title.length).toBeGreaterThan(0);
      expect(p.wcag.length).toBeGreaterThan(0);
      expect(p.correctFix.length).toBeGreaterThan(0);
      expect(FIX_TYPES).toContain(p.fixTypeDefault);
    }
  });
});

describe("frameworkGuidanceFor — narrow selection, React only", () => {
  it("selects React for jsx-a11y / enforce / axe findings", () => {
    for (const provenance of ["jsx-a11y", "enforce", "axe"] as const) {
      expect(frameworkGuidanceFor(enrich(raw({ provenance })))).toBe(REACT_GUIDANCE);
    }
  });

  it("selects React for a .tsx / .jsx source file", () => {
    expect(frameworkGuidanceFor(enrich(raw({ file: "app/page.tsx" })))).toBe(REACT_GUIDANCE);
    expect(frameworkGuidanceFor(enrich(raw({ file: "src/Card.jsx", provenance: "jsx-a11y" })))).toBe(REACT_GUIDANCE);
  });

  it("returns null for a parked (non-web) framework finding", () => {
    const swift = enrich(raw({ provenance: "swiftui", file: "Sources/LoginView.swift", ruleId: "swiftui/label" }));
    expect(frameworkGuidanceFor(swift)).toBeNull();
  });
});
