import { describe, expect, it } from "vitest";
import { enrich, type EnrichedFinding } from "../../../src/corpus";
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

const SUGGESTION_JSON =
  '[{"observation":"A div carries onClick with no semantics.","suggestedFix":"Render a native <button type=\\"button\\">.","wcag":["2.1.1","4.1.2"],"fixType":"FUNCTIONAL-RISK","patternId":"PATTERN-REACT-001"}]';

/** A provider that records the request it saw and returns a canned suggestion reply. */
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

describe("createSkillsReasoner — the reasoning core wired to the seam", () => {
  it("consults the framework guidance as system framing and emits a corpus-agent suggestion", async () => {
    const { provider, seen } = recordingProvider(SUGGESTION_JSON);
    const reasoner = createSkillsReasoner();
    const out = await reasoner.reason(ctx(enriched(), provider));

    // The ported skill reached the model as the system framing.
    expect(seen[0]?.system).toContain("PATTERN-REACT-001");
    expect(seen[0]?.system).toContain("React / Next.js Audit Checklist");

    expect(out).toHaveLength(1);
    const finding = out[0];
    expect(finding?.provenance).toBe("corpus-agent");
    expect(finding?.layer).toBe("recall");
    expect(finding?.patternId).toBe("PATTERN-REACT-001");
    // The fix rides as PROSE on the message — a suggestion, never a patch.
    expect(finding?.message).toContain("Suggested fix (FUNCTIONAL-RISK)");
    expect(finding?.message).toContain("Render a native <button");
  });

  it("emits an advisory `warn` finding even when the source enforcement is `block`", async () => {
    const { provider } = recordingProvider(SUGGESTION_JSON);
    // The default source is `enforcement: "block"`; the agent finding must NOT inherit it.
    const out = await createSkillsReasoner().reason(ctx(enriched({ enforcement: "block" }), provider));
    expect(out).toHaveLength(1);
    expect(out[0]?.enforcement).toBe("warn");
  });

  it("returns [] for a parked (non-React) finding without calling the model", async () => {
    const { provider, seen } = recordingProvider(SUGGESTION_JSON);
    const swift = enriched({ provenance: "swiftui", file: "Sources/View.swift", ruleId: "swiftui/label" });
    const out = await createSkillsReasoner().reason(ctx(swift, provider));
    expect(out).toEqual([]);
    expect(seen).toHaveLength(0);
  });

  it("survives a malformed model reply with an empty pass, never throwing", async () => {
    const { provider } = recordingProvider("Sorry, no structured output today.");
    const out = await createSkillsReasoner().reason(ctx(enriched(), provider));
    expect(out).toEqual([]);
  });

  it("survives a capped/throwing lookup — still produces the suggestion", async () => {
    const { provider } = recordingProvider(SUGGESTION_JSON);
    const throwingLookup: LookupTool = { lookup: async () => { throw new Error("cap"); } };
    const out = await createSkillsReasoner().reason(ctx(enriched(), provider, throwingLookup));
    expect(out).toHaveLength(1);
  });

  it("emits through the canonical contract with agent provenance and NO source on the wire", async () => {
    const { provider } = recordingProvider(SUGGESTION_JSON);
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
    // The suggestion prose survives as the agent finding's rationale.
    expect("rationale" in wire && wire.rationale).toContain("Suggested fix");
  });
});
