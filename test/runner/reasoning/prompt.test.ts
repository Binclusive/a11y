import { describe, expect, it } from "vitest";
import { buildSystemPrompt, buildUserPrompt, parseReasonResponse, REACT_GUIDANCE, suggestionMessage } from "../../../src/runner";

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

  it("asks for BOTH behaviors — an in-place enrichment and new discoveries", () => {
    expect(system).toContain('"enrichment"');
    expect(system).toContain('"discoveries"');
    expect(system).toContain('"confidence"');
    expect(system).toContain("NEW accessibility problems the rule engine MISSED");
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

describe("parseReasonResponse — zod boundary, tolerant, patch-free, never throws", () => {
  it("parses an object into a typed enrichment + discoveries", () => {
    const out = parseReasonResponse(
      JSON.stringify({
        enrichment: { observation: "div has onClick", suggestedFix: "use a button", wcag: ["4.1.2"], fixType: "FUNCTIONAL-RISK", patternId: "PATTERN-REACT-001" },
        discoveries: [
          { observation: "focus escapes", suggestedFix: "trap focus", rationale: "tab leaves the dialog", confidence: "high", wcag: ["2.4.3"], fixType: "SAFE" },
        ],
      }),
    );
    expect(out.enrichment).toEqual({
      observation: "div has onClick",
      suggestedFix: "use a button",
      wcag: ["4.1.2"],
      fixType: "FUNCTIONAL-RISK",
      patternId: "PATTERN-REACT-001",
    });
    expect(out.discoveries).toHaveLength(1);
    expect(out.discoveries[0]?.confidence).toBe("high");
    expect(out.discoveries[0]?.rationale).toBe("tab leaves the dialog");
  });

  it("parses a fenced ```json block", () => {
    const out = parseReasonResponse('```json\n{"enrichment":{"observation":"o","suggestedFix":"f"},"discoveries":[]}\n```');
    expect(out.enrichment?.observation).toBe("o");
    expect(out.discoveries).toEqual([]);
  });

  it("defaults an unknown/absent fixType to the conservative RUNTIME-CHECK", () => {
    const out = parseReasonResponse('{"enrichment":{"observation":"o","suggestedFix":"f","fixType":"WHATEVER"},"discoveries":[]}');
    expect(out.enrichment?.fixType).toBe("RUNTIME-CHECK");
  });

  it("rejects a discovery missing its required rationale/confidence, keeps the valid one", () => {
    const out = parseReasonResponse(
      JSON.stringify({
        enrichment: null,
        discoveries: [
          { observation: "no rationale", suggestedFix: "f", wcag: [], fixType: "SAFE" },
          { observation: "ok", suggestedFix: "f", rationale: "why", confidence: "low", wcag: [], fixType: "SAFE" },
        ],
      }),
    );
    expect(out.discoveries).toHaveLength(1);
    expect(out.discoveries[0]?.observation).toBe("ok");
  });

  it("a malformed enrichment does not sink an otherwise-good discoveries array", () => {
    const out = parseReasonResponse(
      JSON.stringify({
        enrichment: { observation: "" },
        discoveries: [{ observation: "ok", suggestedFix: "f", rationale: "why", confidence: "medium", wcag: [], fixType: "SAFE" }],
      }),
    );
    expect(out.enrichment).toBeNull();
    expect(out.discoveries).toHaveLength(1);
  });

  it("returns an empty result for non-JSON or a non-object reply, never throwing", () => {
    expect(parseReasonResponse("I could not find anything.")).toEqual({ enrichment: null, discoveries: [] });
    expect(parseReasonResponse("{not json")).toEqual({ enrichment: null, discoveries: [] });
    expect(parseReasonResponse("[1, 2, 3]")).toEqual({ enrichment: null, discoveries: [] });
  });
});

describe("suggestionMessage — folds a suggestion into finding prose", () => {
  it("carries the observation, the trust label, and the suggested fix", () => {
    const msg = suggestionMessage({ observation: "div has onClick", suggestedFix: "use a button", wcag: ["4.1.2"], fixType: "FUNCTIONAL-RISK" });
    expect(msg).toBe("div has onClick Suggested fix (FUNCTIONAL-RISK): use a button");
  });
});
