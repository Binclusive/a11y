import { describe, expect, it } from "vitest";
import {
  BLOCK_BEGIN,
  BLOCK_END,
  extractBlock,
  renderBlock,
  slugify,
  spliceBlock,
} from "../src/agents-block";
import type { Contract } from "../src/contract";
import { emptyDeclarations } from "../src/contract";
import type { CorpusPattern } from "../src/corpus";

const patterns: readonly CorpusPattern[] = [
  {
    id: "1.3.1-label",
    sc: "1.3.1",
    orgs: 22,
    tier: "very-common",
    component: "form field",
    failureShape:
      "A field has no programmatic label. It relies on placeholder text only, which AT does not announce.",
    fix: "Associate every field with a <label> via id. Do not rely on placeholder text. Add visible instructions where needed.",
  },
  {
    id: "4.1.2-button-no-name",
    sc: "4.1.2",
    orgs: 21,
    tier: "very-common",
    component: "icon-only button",
    failureShape: "A button exposes no accessible name, so AT announces an unlabeled button.",
    fix: "Give every button discernible text or an aria-label for icon-only buttons.",
  },
  {
    id: "3.3.1-error",
    sc: "3.3.1",
    orgs: 8,
    tier: "occasional",
    component: "error message",
    failureShape: "Form errors are conveyed by color alone.",
    fix: "Identify form errors in text and tie them to the field.",
  },
];

/** 15 synthetic patterns to exercise the 12-line cap + overflow line. */
const manyPatterns: readonly CorpusPattern[] = Array.from({ length: 15 }, (_, i) => ({
  id: `pat-${String(i).padStart(2, "0")}`,
  sc: "4.1.2",
  orgs: 21,
  tier: "very-common" as const,
  component: `component ${i}`,
  failureShape: `Shape ${i}. Extra sentence.`,
  fix: `Fix ${i}.`,
}));

const contract: Contract = {
  version: 1,
  stack: { framework: "next", router: "app", designSystem: "@b8e/design", language: "ts" },
  enforcement: { block: ["1.3.1", "4.1.2"], warn: ["3.3.1"] },
  learned: [
    {
      id: "label-icon-buttons",
      rule: "Label icon-only buttons",
      wcag: ["4.1.2"],
      fix: "aria-label",
      source: "review",
      addedAt: "2026-06-01T00:00:00.000Z",
    },
  ],
  declarations: emptyDeclarations(),
};

describe("slugify", () => {
  it("is deterministic and url-safe", () => {
    expect(slugify("Label icon-only buttons!")).toBe("label-icon-only-buttons");
    expect(slugify("Label icon-only buttons!")).toBe(slugify("Label icon-only buttons!"));
  });
  it("falls back to 'rule' for empty-after-normalization text", () => {
    expect(slugify("!!!")).toBe("rule");
  });
  it("caps length and trims a trailing hyphen", () => {
    const long = "a".repeat(80);
    expect(slugify(long).length).toBeLessThanOrEqual(60);
    expect(slugify("word ".repeat(20)).endsWith("-")).toBe(false);
  });
});

describe("renderBlock", () => {
  it("is delimited by the managed markers", () => {
    const block = renderBlock(contract, patterns);
    expect(block.startsWith(BLOCK_BEGIN)).toBe(true);
    expect(block.endsWith(BLOCK_END)).toBe(true);
  });

  it("renders each distilled pattern: component, SC, tier, aggregate orgs", () => {
    const block = renderBlock(contract, patterns);
    expect(block).toContain("[SC 1.3.1 · VERY COMMON · 22/26 orgs] form field:");
    expect(block).toContain("[SC 4.1.2 · VERY COMMON · 21/26 orgs] icon-only button:");
  });

  it("collapses a multi-sentence failureShape/fix to one terse sentence each", () => {
    const block = renderBlock(contract, patterns);
    // First sentence of the shape, then the arrow, then first sentence of fix.
    expect(block).toContain("A field has no programmatic label.");
    expect(block).not.toContain("which AT does not announce");
    expect(block).toContain("Associate every field with a <label> via id.");
    expect(block).not.toContain("Do not rely on placeholder text");
  });

  it("caps at 12 pattern lines and summarizes the rest as '+N more'", () => {
    const block = renderBlock(contract, manyPatterns);
    // Corpus pattern lines carry " · VERY COMMON]" etc.; the learned line
    // carries " · learned ·" — count only the corpus failure-shape lines.
    const patternLines = block
      .split("\n")
      .filter((l) => l.startsWith("- [SC") && !l.includes("· learned ·"));
    expect(patternLines).toHaveLength(12);
    expect(block).toContain("+3 more in the corpus");
  });

  it("omits the '+N more' line when at or under the cap", () => {
    const block = renderBlock(contract, patterns);
    expect(block).not.toContain("more in the corpus");
  });

  it("includes the learned rules with their source and fix", () => {
    const block = renderBlock(contract, patterns);
    expect(block).toContain("Label icon-only buttons");
    expect(block).toContain("learned · review");
  });

  it("omits the learned section when there are no learned rules", () => {
    const block = renderBlock({ ...contract, learned: [] }, patterns);
    expect(block).not.toContain("Learned (this repo)");
  });

  it("is pure — same inputs yield identical bytes", () => {
    expect(renderBlock(contract, patterns)).toBe(renderBlock(contract, patterns));
  });
});

describe("spliceBlock idempotence + preservation", () => {
  const block = renderBlock(contract, patterns);

  it("creates the file content when none exists", () => {
    const out = spliceBlock(null, block);
    expect(extractBlock(out)).toBe(block);
    expect(out.endsWith("\n")).toBe(true);
  });

  it("re-splicing its own output is a no-op (byte-identical)", () => {
    const once = spliceBlock(null, block);
    const twice = spliceBlock(once, block);
    expect(twice).toBe(once);
  });

  it("preserves content before and after the managed block", () => {
    const head = "# My Agents File\n\nProject-specific instructions here.\n";
    const tail = "## Other section\n\nKeep me too.\n";
    const first = spliceBlock(`${head}\n${BLOCK_BEGIN}\nold body\n${BLOCK_END}\n\n${tail}`, block);
    expect(first).toContain("# My Agents File");
    expect(first).toContain("Project-specific instructions here.");
    expect(first).toContain("## Other section");
    expect(first).toContain("Keep me too.");
    expect(first).not.toContain("old body");
    expect(extractBlock(first)).toBe(block);
    // And idempotent against its own output.
    expect(spliceBlock(first, block)).toBe(first);
  });

  it("appends the block when the file has content but no markers", () => {
    const existing = "# Existing\n\nNo managed block yet.\n";
    const out = spliceBlock(existing, block);
    expect(out).toContain("# Existing");
    expect(out).toContain("No managed block yet.");
    expect(extractBlock(out)).toBe(block);
    expect(spliceBlock(out, block)).toBe(out);
  });

  it("does not accumulate blank lines across regenerations", () => {
    let out = spliceBlock("# Top\n", block);
    for (let i = 0; i < 5; i++) out = spliceBlock(out, block);
    expect(out).not.toMatch(/\n\n\n/);
  });
});

describe("extractBlock", () => {
  it("returns null when no managed block is present", () => {
    expect(extractBlock("# Just a file\n")).toBeNull();
  });
});
