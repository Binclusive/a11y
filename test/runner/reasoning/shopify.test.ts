import { describe, expect, it } from "vitest";
import { enrich } from "../../../src/evidence";
import type { Finding } from "../../../src/index";
import {
  buildSystemPrompt,
  FIX_TYPES,
  frameworkGuidanceFor,
  REACT_GUIDANCE,
  SHOPIFY_GUIDANCE,
} from "../../../src/runner";

const raw = (over: Partial<Finding> = {}): Finding => ({
  file: "sections/header.liquid",
  line: 8,
  ruleId: "liquid/icon-only-control",
  message: "cart icon control has no accessible name",
  wcag: ["4.1.2"],
  enforcement: "block",
  provenance: "liquid",
  ...over,
});

describe("shopify guidance — the ported reasoning core", () => {
  it("carries the ported checklist areas from the Shopify theme reference", () => {
    const titles = SHOPIFY_GUIDANCE.checklist.map((a) => a.title);
    expect(titles).toEqual([
      "Theme Structure Signals",
      "High-Risk Shopify Patterns",
      "Layout and Global Shell",
      "Templates, Sections, and Blocks",
      "Links, Buttons, and Controls",
      "Forms",
      "Dynamic UI",
      "Media and Visual Content",
      "CSS, Motion, and Visual States",
    ]);
    for (const area of SHOPIFY_GUIDANCE.checklist) expect(area.items.length).toBeGreaterThan(0);
  });

  it("carries the five seed patterns, each fully populated with a valid fix type", () => {
    expect(SHOPIFY_GUIDANCE.patterns.map((p) => p.id)).toEqual([
      "PATTERN-SHOPIFY-001",
      "PATTERN-SHOPIFY-002",
      "PATTERN-SHOPIFY-003",
      "PATTERN-SHOPIFY-004",
      "PATTERN-SHOPIFY-005",
    ]);
    for (const p of SHOPIFY_GUIDANCE.patterns) {
      expect(p.title.length).toBeGreaterThan(0);
      expect(p.wcag.length).toBeGreaterThan(0);
      expect(p.correctFix.length).toBeGreaterThan(0);
      expect(FIX_TYPES).toContain(p.fixTypeDefault);
    }
  });
});

describe("frameworkGuidanceFor — Shopify selected only for its own stack", () => {
  it("selects Shopify for a `liquid` finding and a `.liquid` source file", () => {
    expect(frameworkGuidanceFor(enrich(raw()))).toBe(SHOPIFY_GUIDANCE);
    expect(frameworkGuidanceFor(enrich(raw({ file: "snippets/product-card.liquid" })))).toBe(SHOPIFY_GUIDANCE);
    expect(frameworkGuidanceFor(enrich(raw({ file: "templates/product.json" })))).toBe(SHOPIFY_GUIDANCE);
  });

  it("claims a theme's own `.js`/`.css` asset via the `liquid` provenance, not React", () => {
    // A theme asset is extension-shadowed by React's `.js` list; provenance is the authority.
    expect(frameworkGuidanceFor(enrich(raw({ file: "assets/cart-drawer.js" })))).toBe(SHOPIFY_GUIDANCE);
  });

  it("does NOT select Shopify for a React finding", () => {
    const react = enrich(raw({ provenance: "jsx-a11y", file: "app/page.tsx", ruleId: "jsx-a11y/alt-text" }));
    expect(frameworkGuidanceFor(react)).toBe(REACT_GUIDANCE);
    expect(frameworkGuidanceFor(react)).not.toBe(SHOPIFY_GUIDANCE);
  });

  it("does NOT let React claim a Shopify `.liquid` finding", () => {
    expect(frameworkGuidanceFor(enrich(raw()))).not.toBe(REACT_GUIDANCE);
  });
});

describe("buildSystemPrompt — the reshaped Shopify skill reaches the model", () => {
  const system = buildSystemPrompt(SHOPIFY_GUIDANCE);

  it("folds in the Shopify checklist areas and the pattern catalog", () => {
    expect(system).toContain("High-Risk Shopify Patterns");
    expect(system).toContain("Dynamic UI");
    expect(system).toContain("PATTERN-SHOPIFY-001: CTA link rendered as a disabled fake link");
    expect(system).toContain("Correct fix:");
  });
});
