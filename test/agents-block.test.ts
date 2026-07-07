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
    const block = renderBlock(contract);
    expect(block.startsWith(BLOCK_BEGIN)).toBe(true);
    expect(block.endsWith(BLOCK_END)).toBe(true);
  });

  it("renders the stack + enforcement contract", () => {
    const block = renderBlock(contract);
    expect(block).toContain("Stack: next (app router) · @b8e/design · ts");
    expect(block).toContain("Enforcement — block: 1.3.1, 4.1.2 · warn: 3.3.1");
  });

  it("carries no corpus/frequency framing (ADR 0041 §G — the corpus left the engine)", () => {
    const block = renderBlock(contract);
    expect(block).not.toContain("Corpus patterns");
    expect(block).not.toMatch(/orgs/i);
    expect(block).not.toMatch(/very common/i);
  });

  it("includes the learned rules with their source and fix", () => {
    const block = renderBlock(contract);
    expect(block).toContain("Label icon-only buttons");
    expect(block).toContain("learned · review");
  });

  it("omits the learned section when there are no learned rules", () => {
    const block = renderBlock({ ...contract, learned: [] });
    expect(block).not.toContain("Learned (this repo)");
  });

  it("is pure — same inputs yield identical bytes", () => {
    expect(renderBlock(contract)).toBe(renderBlock(contract));
  });

  it("emits the ROBOT MODE protocol so any AGENTS.md-reading agent runs the same loop", () => {
    const block = renderBlock(contract);
    expect(block).toContain("`binclusive-a11y` MCP tools");
    expect(block).toContain("Re-scan after each change");
    expect(block).toContain("never claim compliance");
  });
});

describe("spliceBlock idempotence + preservation", () => {
  const block = renderBlock(contract);

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
