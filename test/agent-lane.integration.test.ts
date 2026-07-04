/**
 * The AI-lane TRACER TEST — proves the vertical slice is CONNECTED, not just
 * that four clean library layers exist (issue #2182, epic #2083).
 *
 * The failure this guards against: `runAgentLane`, the skills reasoner, the
 * code-graph lookup, and enrich/discover were all merged but nothing invoked
 * them. These tests drive the ACTUAL `check` scan path (`runCheck`) with a stub
 * provider and assert an agent-provenance finding travels all the way to the
 * rendered SARIF / JSON output — the whole point of the slice.
 *
 * Two invariants proven end to end, at the integration level:
 *   1. CONNECTED: a stub provider that returns a known discovery → at least one
 *      `corpus-agent` finding appears in the rendered output, advisory (warn),
 *      with no file/line on the metadata-only wire projection.
 *   2. NON-BLOCKING: a provider that THROWS → the scan still succeeds (exit 0)
 *      with only the deterministic findings — the AI lane never fails the run.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { augmentWithAgentLane } from "../src/agent-lane";
import { runCheck } from "../src/cli";
import { toContractFinding } from "../src/emit-contract";
import { scan } from "../src/core";
import { enrichAll } from "../src/corpus";
import type { Provider } from "../src/runner/provider";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, "fixtures", "agent-lane");

/**
 * A stub provider that returns a KNOWN discovery — a missing-main-landmark issue
 * (WCAG 1.3.1) the deterministic `alt-text` pass (WCAG 1.1.1) could never catch,
 * so it survives cross-dedup and reaches output as a `corpus-agent` finding.
 */
const KNOWN_OBSERVATION = "The page has no main landmark region";
const discoveringProvider: Provider = {
  async complete() {
    return {
      text: JSON.stringify({
        enrichment: null,
        discoveries: [
          {
            observation: KNOWN_OBSERVATION,
            suggestedFix: "Wrap the primary content in a <main> element",
            rationale: "Screen-reader users cannot jump to the main content without a landmark",
            confidence: "high",
            wcag: ["1.3.1"],
            fixType: "FUNCTIONAL-RISK",
            element: "body",
          },
        ],
      }),
      usage: { inputTokens: 120, outputTokens: 60 },
    };
  },
};

/** A provider that THROWS on every call — the non-blocking degradation case. */
const throwingProvider: Provider = {
  async complete() {
    throw new Error("simulated provider transport failure");
  },
};

/** Capture everything the runner writes to stdout during one `runCheck`. */
async function captureCheck(
  args: Parameters<typeof runCheck>,
): Promise<{ readonly out: string; readonly exitCode: number }> {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  const priorExit = process.exitCode;
  process.exitCode = 0;
  try {
    await runCheck(...args);
    const out = spy.mock.calls.map((c) => String(c[0])).join("\n");
    return { out, exitCode: Number(process.exitCode ?? 0) };
  } finally {
    spy.mockRestore();
    process.exitCode = priorExit;
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AI-lane vertical slice (tracer)", () => {
  it("a discovered agent finding reaches the rendered SARIF output", async () => {
    const { out, exitCode } = await captureCheck([
      fixtureDir,
      false,
      true,
      "tracer-run",
      { provider: discoveringProvider },
    ]);

    const sarif = JSON.parse(out);
    const results: Array<{ ruleId: string; message: { text: string }; properties: { provenance: string } }> =
      sarif.runs[0].results;

    // The deterministic floor is still there…
    expect(results.some((r) => r.properties.provenance === "deterministic")).toBe(true);
    // …and the agent finding travelled all the way through render.
    const agentResults = results.filter((r) => r.properties.provenance === "agent");
    expect(agentResults.length).toBeGreaterThan(0);
    expect(agentResults.some((r) => r.message.text.includes(KNOWN_OBSERVATION))).toBe(true);

    // Advisory: agent findings are warn-only, so the scan never blocks on them.
    expect(exitCode).toBe(0);
  });

  it("a discovered agent finding reaches the rendered JSON report", async () => {
    const { out } = await captureCheck([
      fixtureDir,
      true,
      false,
      "local",
      { provider: discoveringProvider },
    ]);

    const report = JSON.parse(out);
    const agent = report.findings.filter((f: { provenance: string }) => f.provenance === "corpus-agent");
    expect(agent.length).toBeGreaterThan(0);
    expect(agent[0].enforcement).toBe("warn");
  });

  it("the agent finding is advisory (warn) and drops file/line on the wire projection", async () => {
    const file = join(fixtureDir, "Hero.tsx");
    const deterministic = enrichAll((await scan([file])).findings);
    const augmented = await augmentWithAgentLane(deterministic, fixtureDir, {}, { provider: discoveringProvider });

    const agent = augmented.filter((f) => f.provenance === "corpus-agent");
    expect(agent.length).toBeGreaterThan(0);
    // Advisory by construction.
    expect(agent.every((f) => f.enforcement === "warn")).toBe(true);

    // Metadata-only wire: the contract projection carries no source locator.
    const wire = toContractFinding(agent[0]!, "ci-diff");
    expect(wire.provenance).toBe("agent");
    expect(Object.keys(wire)).not.toContain("file");
    expect(Object.keys(wire)).not.toContain("line");
    expect(Object.keys(wire)).not.toContain("ruleId");
  });

  it("a provider that THROWS still succeeds (exit 0) with just the deterministic floor", async () => {
    const { out, exitCode } = await captureCheck([
      fixtureDir,
      false,
      true,
      "throw-run",
      { provider: throwingProvider },
    ]);

    const sarif = JSON.parse(out);
    const results: Array<{ properties: { provenance: string } }> = sarif.runs[0].results;

    // Deterministic floor survives; no agent findings; the run never failed.
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.properties.provenance === "agent")).toBe(false);
    expect(exitCode).toBe(0);
  });

  it("no provider (no LLM key) → the deterministic floor, unchanged", async () => {
    const file = join(fixtureDir, "Hero.tsx");
    const deterministic = enrichAll((await scan([file])).findings);
    // Empty env, no override → resolveProvider returns null → passthrough.
    const augmented = await augmentWithAgentLane(deterministic, fixtureDir, {});
    expect(augmented).toEqual(deterministic);
  });
});
