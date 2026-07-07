import { describe, expect, it } from "vitest";
import { Finding as ContractFinding, parseFindingPayload } from "@binclusive/a11y-contract";
import { enrich } from "../../src/evidence";
import type { EnrichedFinding, Finding } from "../../src/index";
import {
  type AgentFinding,
  type AgentReasoner,
  type LookupTool,
  type Provider,
  type ProviderResponse,
  type ReasonContext,
  type ReasonResult,
  runAgentLane,
} from "../../src/runner";

/**
 * The cap -> partial -> exit-0 behavior IS the runner's contract (epic #2083
 * testing strategy). These lock it directly: the loop is non-blocking, the token
 * ceiling yields a `capped` partial (never a failure), the lookup cap is soft, and
 * whatever it emits validates against the canonical contract with no source on the
 * wire.
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

/** A deterministic finding the runner consumes as loop input. */
const deterministic = (ruleId: string): EnrichedFinding => enrich(raw({ ruleId }));

/**
 * A DISCOVERED agent finding — a NEW issue with locators DISTINCT from the
 * deterministic floor (line 99 / SC 2.4.3, unique patternId), so it survives the
 * runner's dedup against the floor. `key` keys the patternId, so two discoveries
 * with different keys survive self-dedup too.
 */
function discovery(key: string, message: string): AgentFinding {
  const base = enrich(
    raw({ provenance: "corpus-agent", layer: "recall", patternId: `p-${key}`, line: 99, message, wcag: ["2.4.3"], confidence: "medium" }),
  );
  return { ...base, provenance: "corpus-agent" };
}

/** Wrap discoveries (and an optional in-place enrichment note) into a ReasonResult. */
function result(discoveries: readonly AgentFinding[], enrichment: string | null = null): ReasonResult {
  return { enrichment, discoveries };
}

/** A provider that spends a fixed number of tokens per call and echoes a canned text. */
function fakeProvider(perCall: ProviderResponse["usage"], text = "ok"): Provider {
  return { complete: async () => ({ text, usage: perCall }) };
}

/** A lookup tool that always answers — the harness caps how many times it is reached. */
const okLookup: LookupTool = { lookup: async () => ({ status: "ok", data: {} }) };

/** A reasoner that makes one provider call, then discovers one new finding. */
function onePassReasoner(): AgentReasoner {
  return {
    reason: async (ctx: ReasonContext) => {
      await ctx.provider.complete({ messages: [{ role: "user", content: ctx.finding.ruleId }] });
      return result([discovery(ctx.finding.ruleId, `found near ${ctx.finding.ruleId}`)]);
    },
  };
}

describe("runAgentLane — non-blocking", () => {
  it("returns a RunOutcome for empty input, never throws", async () => {
    const out = await runAgentLane({
      findings: [],
      reasoner: onePassReasoner(),
      provider: fakeProvider({ inputTokens: 1, outputTokens: 1 }),
      lookup: okLookup,
      scope: "pr-1",
    });
    expect(out.status).toBe("complete");
    expect(out.findings).toEqual([]);
    expect(out.payload.findings).toEqual([]);
  });

  it("a provider that throws on every call never fails the run (all passes errored, exit-0)", async () => {
    const throwing: Provider = {
      complete: async () => {
        throw new Error("network down");
      },
    };
    const out = await runAgentLane({
      findings: [deterministic("r1"), deterministic("r2")],
      reasoner: onePassReasoner(),
      provider: throwing,
      lookup: okLookup,
      scope: "pr-1",
    });
    // Non-blocking: a total provider outage is a complete run with zero findings,
    // not a rejection and not a `capped`.
    expect(out.status).toBe("complete");
    expect(out.findings).toEqual([]);
    expect(out.passes.every((p) => p.outcome.kind === "errored")).toBe(true);
  });

  it("a reasoner that rejects records an errored pass and keeps going", async () => {
    let call = 0;
    const flaky: AgentReasoner = {
      reason: async (ctx) => {
        call += 1;
        if (call === 1) throw new Error("bad model output");
        return result([discovery(ctx.finding.ruleId, `ok ${ctx.finding.ruleId}`)]);
      },
    };
    const out = await runAgentLane({
      findings: [deterministic("r1"), deterministic("r2")],
      reasoner: flaky,
      provider: fakeProvider({ inputTokens: 1, outputTokens: 1 }),
      lookup: okLookup,
      scope: "pr-1",
    });
    expect(out.status).toBe("complete");
    expect(out.findings).toHaveLength(1);
    expect(out.passes[0].outcome.kind).toBe("errored");
    expect(out.passes[1].outcome.kind).toBe("produced");
  });
});

describe("runAgentLane — the hard per-PR token ceiling", () => {
  it("stops pulling new findings once the ceiling is hit and returns a partial (capped)", async () => {
    // Each pass spends 60 tokens; ceiling 60 admits exactly one full pass (which
    // empties the wallet), then the next pass finds it empty at its boundary and
    // is skipped along with the rest.
    const out = await runAgentLane({
      findings: [deterministic("r1"), deterministic("r2"), deterministic("r3")],
      reasoner: onePassReasoner(),
      provider: fakeProvider({ inputTokens: 30, outputTokens: 30 }),
      lookup: okLookup,
      scope: "pr-9",
      config: { tokenCeiling: 60, lookupsPerFinding: 5 },
    });
    expect(out.status).toBe("capped");
    if (out.status !== "capped") return;
    expect(out.cappedBy).toBe("token-ceiling");
    expect(out.processed).toBe(1);
    expect(out.skipped).toBe(2);
    expect(out.processed + out.skipped).toBe(3);
    // The one finding produced before the cap is KEPT (partial, not discarded).
    expect(out.findings).toHaveLength(1);
    expect(out.payload.findings).toHaveLength(1);
    expect(out.passes.map((p) => p.outcome.kind)).toEqual(["produced", "skipped", "skipped"]);
  });

  it("hard-stops a runaway pass mid-flight (the meter refuses a call with no budget)", async () => {
    // A reasoner that loops provider calls inside ONE pass; the ceiling must stop
    // it via the mid-pass guard, discarding that pass's partial work.
    const runaway: AgentReasoner = {
      reason: async (ctx) => {
        for (let i = 0; i < 100; i += 1) {
          await ctx.provider.complete({ messages: [{ role: "user", content: `${i}` }] });
        }
        return result([discovery("x", "never reached")]);
      },
    };
    const out = await runAgentLane({
      findings: [deterministic("r1"), deterministic("r2")],
      reasoner: runaway,
      provider: fakeProvider({ inputTokens: 20, outputTokens: 20 }),
      lookup: okLookup,
      scope: "pr-9",
      config: { tokenCeiling: 100, lookupsPerFinding: 5 },
    });
    expect(out.status).toBe("capped");
    if (out.status !== "capped") return;
    // The runaway pass produced nothing (its partial work was discarded), and the
    // second finding was skipped. Spend stayed within one call of the ceiling.
    expect(out.findings).toEqual([]);
    expect(out.usage.used).toBeLessThanOrEqual(out.usage.ceiling + 40);
    expect(out.passes.map((p) => p.outcome.kind)).toEqual(["skipped", "skipped"]);
  });

  it("processes every finding under a generous ceiling (complete)", async () => {
    const out = await runAgentLane({
      findings: [deterministic("r1"), deterministic("r2")],
      reasoner: onePassReasoner(),
      provider: fakeProvider({ inputTokens: 5, outputTokens: 5 }),
      lookup: okLookup,
      scope: "pr-9",
      config: { tokenCeiling: 10_000, lookupsPerFinding: 5 },
    });
    expect(out.status).toBe("complete");
    expect(out.findings).toHaveLength(2);
  });
});

describe("runAgentLane — the soft per-finding lookup cap", () => {
  it("caps lookups per finding without ending the run", async () => {
    const seen: string[] = [];
    const greedy: AgentReasoner = {
      reason: async (ctx) => {
        for (let i = 0; i < 10; i += 1) {
          const r = await ctx.lookup.lookup({ kind: "renders", target: `${i}` });
          seen.push(r.status);
        }
        return result([discovery("greedy", "used what lookups it got")]);
      },
    };
    const out = await runAgentLane({
      findings: [deterministic("r1")],
      reasoner: greedy,
      provider: fakeProvider({ inputTokens: 1, outputTokens: 1 }),
      lookup: okLookup,
      scope: "pr-9",
      config: { tokenCeiling: 10_000, lookupsPerFinding: 3 },
    });
    // Soft cap: 3 lookups answered `ok`, the rest `capped`, finding still produced.
    expect(seen.filter((s) => s === "ok")).toHaveLength(3);
    expect(seen.filter((s) => s === "capped")).toHaveLength(7);
    expect(out.status).toBe("complete");
    expect(out.findings).toHaveLength(1);
    expect(out.passes[0].lookupsUsed).toBe(3);
  });

  it("gives each finding a FRESH lookup budget", async () => {
    const perFinding: number[] = [];
    const reasoner: AgentReasoner = {
      reason: async (ctx) => {
        let ok = 0;
        for (let i = 0; i < 5; i += 1) {
          const r = await ctx.lookup.lookup({ kind: "renders", target: `${i}` });
          if (r.status === "ok") ok += 1;
        }
        perFinding.push(ok);
        return result([]);
      },
    };
    await runAgentLane({
      findings: [deterministic("r1"), deterministic("r2")],
      reasoner,
      provider: fakeProvider({ inputTokens: 1, outputTokens: 1 }),
      lookup: okLookup,
      scope: "pr-9",
      config: { tokenCeiling: 10_000, lookupsPerFinding: 2 },
    });
    expect(perFinding).toEqual([2, 2]);
  });
});

describe("runAgentLane — enrich in place (#2098)", () => {
  it("folds an agentNote onto the source finding, which stays deterministic and off the agent payload", async () => {
    const enricher: AgentReasoner = { reason: async () => result([], "Add an alt describing the product.") };
    const out = await runAgentLane({
      findings: [deterministic("r1")],
      reasoner: enricher,
      provider: fakeProvider({ inputTokens: 1, outputTokens: 1 }),
      lookup: okLookup,
      scope: "pr-1",
    });
    expect(out.status).toBe("complete");
    // The source finding gained the note but is still a deterministic finding.
    expect(out.enrichedFindings).toHaveLength(1);
    expect(out.enrichedFindings[0].agentNote).toBe("Add an alt describing the product.");
    expect(out.enrichedFindings[0].provenance).toBe("jsx-a11y");
    // Enrichment is NOT a discovery: nothing on the agent lane / wire payload.
    expect(out.findings).toEqual([]);
    expect(out.payload.findings).toEqual([]);
    // The pass reads as productive (enriched), not empty.
    expect(out.passes[0].outcome).toEqual({ kind: "produced", discovered: 0, enriched: true });
  });
});

describe("runAgentLane — dedup discoveries (#2098)", () => {
  it("drops a discovery that duplicates a deterministic finding (same file:line:SC)", async () => {
    // A discovery colliding with the floor's file:line:SC — the floor already caught it.
    const colliding = (): AgentFinding => {
      const base = enrich(raw({ provenance: "corpus-agent", layer: "recall", patternId: "pc", message: "dup of floor", wcag: ["1.1.1"] }));
      return { ...base, provenance: "corpus-agent" };
    };
    const out = await runAgentLane({
      findings: [deterministic("r1")],
      reasoner: { reason: async () => result([colliding()]) },
      provider: fakeProvider({ inputTokens: 1, outputTokens: 1 }),
      lookup: okLookup,
      scope: "pr-1",
    });
    expect(out.status).toBe("complete");
    expect(out.findings).toEqual([]);
    expect(out.payload.findings).toEqual([]);
  });

  it("collapses two discoveries that duplicate each other (same file:line:patternId)", async () => {
    // Both passes surface the SAME pattern on the same anchor — one finding, not two.
    const twin = (): AgentFinding => {
      const base = enrich(raw({ provenance: "corpus-agent", layer: "recall", line: 99, patternId: "same", message: "same issue", wcag: ["2.4.3"] }));
      return { ...base, provenance: "corpus-agent" };
    };
    const out = await runAgentLane({
      findings: [deterministic("r1"), deterministic("r2")],
      reasoner: { reason: async () => result([twin()]) },
      provider: fakeProvider({ inputTokens: 1, outputTokens: 1 }),
      lookup: okLookup,
      scope: "pr-1",
    });
    expect(out.status).toBe("complete");
    expect(out.findings).toHaveLength(1);
    expect(out.payload.findings).toHaveLength(1);
  });
});

describe("runAgentLane — the emit boundary is the canonical contract", () => {
  it("emits agent findings that validate against the contract with no source on the wire", async () => {
    const out = await runAgentLane({
      findings: [deterministic("r1"), deterministic("r2")],
      reasoner: onePassReasoner(),
      provider: fakeProvider({ inputTokens: 1, outputTokens: 1 }),
      lookup: okLookup,
      scope: "pr-42",
    });
    expect(() => parseFindingPayload(out.payload)).not.toThrow();
    for (const f of out.payload.findings) {
      expect(() => ContractFinding.parse(f)).not.toThrow();
      expect(f.provenance).toBe("agent");
      expect(f.scope).toBe("pr-42");
      expect(f).not.toHaveProperty("file");
      expect(f).not.toHaveProperty("line");
      expect(f).not.toHaveProperty("ruleId");
    }
  });
});
