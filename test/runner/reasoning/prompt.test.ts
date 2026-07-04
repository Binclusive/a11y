import { describe, expect, it } from "vitest";
import { buildSystemPrompt, buildUserPrompt, parseSuggestions, REACT_GUIDANCE, suggestionMessage } from "../../../src/runner";

describe("buildSystemPrompt — the reshaped skill reaches the model", () => {
  const system = buildSystemPrompt(REACT_GUIDANCE);

  it("folds in the checklist areas and the pattern catalog", () => {
    expect(system).toContain("High-Risk React Patterns");
    expect(system).toContain("PATTERN-REACT-001: Non-semantic click target");
    expect(system).toContain("Correct fix:");
  });

  it("states the suggestion-only output contract and forbids diffs/patches", () => {
    expect(system).toContain("You SUGGEST fixes; you never apply them");
    expect(system).toContain("Never emit a diff, patch, or file edit");
  });
});

describe("buildUserPrompt", () => {
  it("states the finding and includes corpus + structural context when present", () => {
    const finding = { file: "src/x.tsx", line: 1, ruleId: "jsx-a11y/no-static-element-interactions", message: "div onClick", wcag: ["2.1.1"], enforcement: "block", provenance: "jsx-a11y" } as const;
    const prompt = buildUserPrompt(finding, "render a button", "Card renders <div>");
    expect(prompt).toContain("jsx-a11y/no-static-element-interactions");
    expect(prompt).toContain("corpus fix hint: render a button");
    expect(prompt).toContain("structural context: Card renders <div>");
  });
});

describe("parseSuggestions — tolerant, patch-free, never throws", () => {
  it("parses a bare JSON array into typed suggestions", () => {
    const out = parseSuggestions(
      '[{"observation":"div has onClick","suggestedFix":"use a button","wcag":["4.1.2"],"fixType":"FUNCTIONAL-RISK","patternId":"PATTERN-REACT-001"}]',
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      observation: "div has onClick",
      suggestedFix: "use a button",
      wcag: ["4.1.2"],
      fixType: "FUNCTIONAL-RISK",
      patternId: "PATTERN-REACT-001",
    });
  });

  it("parses a fenced ```json block", () => {
    const out = parseSuggestions('```json\n[{"observation":"o","suggestedFix":"f"}]\n```');
    expect(out).toHaveLength(1);
    expect(out[0]?.observation).toBe("o");
  });

  it("defaults an unknown/absent fixType to the conservative RUNTIME-CHECK", () => {
    const out = parseSuggestions('[{"observation":"o","suggestedFix":"f","fixType":"WHATEVER"}]');
    expect(out[0]?.fixType).toBe("RUNTIME-CHECK");
  });

  it("drops malformed entries, keeps the valid subset", () => {
    const out = parseSuggestions('[{"observation":"ok","suggestedFix":"f"},{"observation":""},{"nope":1}]');
    expect(out).toHaveLength(1);
    expect(out[0]?.observation).toBe("ok");
  });

  it("returns [] for non-JSON or a non-array reply, never throwing", () => {
    expect(parseSuggestions("I could not find anything.")).toEqual([]);
    expect(parseSuggestions("{not json")).toEqual([]);
    expect(parseSuggestions('{"observation":"o","suggestedFix":"f"}')).toEqual([]);
  });
});

describe("suggestionMessage — folds a suggestion into finding prose", () => {
  it("carries the observation, the trust label, and the suggested fix", () => {
    const msg = suggestionMessage({ observation: "div has onClick", suggestedFix: "use a button", wcag: ["4.1.2"], fixType: "FUNCTIONAL-RISK" });
    expect(msg).toBe("div has onClick Suggested fix (FUNCTIONAL-RISK): use a button");
  });
});
