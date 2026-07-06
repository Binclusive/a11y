import { describe, expect, it } from "vitest";
import { enrich, type EnrichedFinding } from "../../../src/evidence";
import type { Finding } from "../../../src/index";
import {
  createSkillsReasoner,
  type LookupTool,
  type Provider,
  type ProviderRequest,
  type ReasonContext,
  runAgentLane,
} from "../../../src/runner";

const raw = (over: Partial<Finding> = {}): Finding => ({
  file: "src/Card.tsx",
  line: 12,
  ruleId: "jsx-a11y/no-static-element-interactions",
  message: "div with onClick has no role/keyboard support",
  wcag: ["2.1.1"],
  enforcement: "block",
  provenance: "jsx-a11y",
  ...over,
});

const enriched = (over: Partial<Finding> = {}): EnrichedFinding => enrich(raw(over));

/** The two behaviors, as the model returns them: an enrichment object + a discoveries array. */
const ENRICH_JSON = JSON.stringify({
  enrichment: {
    observation: "A div carries onClick with no semantics.",
    suggestedFix: 'Render a native <button type="button">.',
    wcag: ["2.1.1", "4.1.2"],
    fixType: "FUNCTIONAL-RISK",
    patternId: "PATTERN-REACT-001",
  },
  discoveries: [],
});

const DISCOVER_JSON = JSON.stringify({
  enrichment: null,
  discoveries: [
    {
      observation: "Two sibling cards share the same heading level, breaking the outline.",
      suggestedFix: "Demote the inner card title to an h3.",
      rationale: "A screen-reader user relies on heading structure to skim; a flat outline hides the hierarchy.",
      confidence: "high",
      wcag: ["2.4.3"],
      fixType: "FUNCTIONAL-RISK",
      patternId: "PATTERN-REACT-009",
      element: "section.card h2",
    },
  ],
});

/** A provider that records the request it saw and returns a canned reply. */
function recordingProvider(text: string): { provider: Provider; seen: ProviderRequest[] } {
  const seen: ProviderRequest[] = [];
  const provider: Provider = {
    complete: async (request) => {
      seen.push(request);
      return { text, usage: { inputTokens: 100, outputTokens: 20 } };
    },
  };
  return { provider, seen };
}

const okLookup: LookupTool = { lookup: async () => ({ status: "ok", data: { component: "Card" } }) };

function ctx(finding: EnrichedFinding, provider: Provider, lookup: LookupTool = okLookup): ReasonContext {
  return { finding, provider, lookup, scope: "pr-1" };
}

describe("createSkillsReasoner — enrich in place", () => {
  it("returns an in-place note for the source finding and no discovery", async () => {
    const { provider } = recordingProvider(ENRICH_JSON);
    const out = await createSkillsReasoner().reason(ctx(enriched(), provider));
    expect(out.discoveries).toEqual([]);
    // The note is prose the harness folds onto the deterministic finding — never a patch.
    expect(out.enrichment).toContain("Suggested fix (FUNCTIONAL-RISK)");
    expect(out.enrichment).toContain("Render a native <button");
  });
});

describe("createSkillsReasoner — discover", () => {
  it("consults the framework guidance as system framing and discovers a corpus-agent finding", async () => {
    const { provider, seen } = recordingProvider(DISCOVER_JSON);
    const out = await createSkillsReasoner().reason(ctx(enriched(), provider));

    // The ported skill reached the model as the system framing.
    expect(seen[0]?.system).toContain("PATTERN-REACT-001");
    expect(seen[0]?.system).toContain("React / Next.js Audit Checklist");

    expect(out.discoveries).toHaveLength(1);
    const finding = out.discoveries[0];
    expect(finding?.provenance).toBe("corpus-agent");
    expect(finding?.layer).toBe("recall");
    expect(finding?.patternId).toBe("PATTERN-REACT-009");
    expect(finding?.confidence).toBe("high");
    expect(finding?.selector).toBe("section.card h2");
    // Rationale + fix ride as PROSE on the message — a suggestion, never a patch.
    expect(finding?.message).toContain("Rationale:");
    expect(finding?.message).toContain("Suggested fix (FUNCTIONAL-RISK)");
  });

  it("emits an advisory `warn` finding even when the source enforcement is `block`", async () => {
    const { provider } = recordingProvider(DISCOVER_JSON);
    const out = await createSkillsReasoner().reason(ctx(enriched({ enforcement: "block" }), provider));
    expect(out.discoveries).toHaveLength(1);
    expect(out.discoveries[0]?.enforcement).toBe("warn");
  });
});

describe("createSkillsReasoner — the zod output boundary rejects, never trusts", () => {
  it("drops a malformed discovery (missing rationale/confidence), keeps the valid one", async () => {
    const mixed = JSON.stringify({
      enrichment: null,
      discoveries: [
        // Malformed: a discovery with no rationale and no confidence — rejected at the boundary.
        { observation: "vague", suggestedFix: "do something", wcag: [], fixType: "SAFE" },
        // Valid.
        {
          observation: "Focus escapes the modal.",
          suggestedFix: "Trap focus within the dialog.",
          rationale: "Keyboard users tab out of an open dialog into the page behind it.",
          confidence: "medium",
          wcag: ["2.4.3"],
          fixType: "FUNCTIONAL-RISK",
        },
      ],
    });
    const { provider } = recordingProvider(mixed);
    const out = await createSkillsReasoner().reason(ctx(enriched(), provider));
    expect(out.discoveries).toHaveLength(1);
    expect(out.discoveries[0]?.message).toContain("Trap focus");
  });

  it("returns an empty result for a parked (non-React) finding without calling the model", async () => {
    const { provider, seen } = recordingProvider(DISCOVER_JSON);
    const swift = enriched({ provenance: "swiftui", file: "Sources/View.swift", ruleId: "swiftui/label" });
    const out = await createSkillsReasoner().reason(ctx(swift, provider));
    expect(out.enrichment).toBeNull();
    expect(out.discoveries).toEqual([]);
    expect(seen).toHaveLength(0);
  });

  it("survives a malformed model reply with an empty pass, never throwing", async () => {
    const { provider } = recordingProvider("Sorry, no structured output today.");
    const out = await createSkillsReasoner().reason(ctx(enriched(), provider));
    expect(out.enrichment).toBeNull();
    expect(out.discoveries).toEqual([]);
  });

  it("survives a capped/throwing lookup — still discovers", async () => {
    const { provider } = recordingProvider(DISCOVER_JSON);
    const throwingLookup: LookupTool = {
      lookup: async () => {
        throw new Error("cap");
      },
    };
    const out = await createSkillsReasoner().reason(ctx(enriched(), provider, throwingLookup));
    expect(out.discoveries).toHaveLength(1);
  });
});

describe("createSkillsReasoner — the canonical contract emit", () => {
  it("emits through the contract with agent provenance and NO source on the wire", async () => {
    const { provider } = recordingProvider(DISCOVER_JSON);
    const outcome = await runAgentLane({
      findings: [enriched()],
      reasoner: createSkillsReasoner(),
      provider,
      lookup: okLookup,
      scope: "pr-1",
    });
    expect(outcome.payload.findings).toHaveLength(1);
    const wire = outcome.payload.findings[0];
    expect(wire.provenance).toBe("agent");
    expect(wire.scope).toBe("pr-1");
    // Metadata discipline: no source locator crosses the wire.
    expect(wire).not.toHaveProperty("file");
    expect(wire).not.toHaveProperty("line");
    // The discovery prose survives as the agent finding's rationale.
    expect("rationale" in wire && wire.rationale).toContain("Suggested fix");
  });
});
