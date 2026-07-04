/**
 * The AI-lane WIRE-IN — the vertical seam that makes the runner (#2095), the
 * skills reasoner (#2096), the code-graph lookup (#2097), and enrich/discover
 * (#2098) actually RUN from the CI scan path (epic #2083, issue #2182).
 *
 * The library pieces all shipped clean but disconnected: nothing invoked
 * `runAgentLane`, and no concrete `Provider` existed, so a bare `LLM_API_KEY`
 * drove nothing. This module is the missing invocation. It sits AFTER the
 * deterministic scan in `runCheck` and, WHEN a key is present, drives the agent
 * lane over the deterministic findings and folds the result back into the SAME
 * `EnrichedFinding[]` every render path already consumes — the PR-comment JSON,
 * the SARIF, and the phone-home envelope. One list in, an augmented list out.
 *
 * NON-BLOCKING BY CONSTRUCTION, at the integration level (not just the unit
 * level): {@link augmentWithAgentLane} NEVER throws and NEVER returns fewer
 * findings than it was given. No key → the deterministic floor, unchanged. A
 * provider that throws, times out, hits the token ceiling, or returns garbage →
 * the runner degrades it to "no agent findings", and this returns the
 * deterministic findings (some possibly carrying an in-place `agentNote`). The
 * caller can always `exit 0`.
 *
 * ADVISORY BY CONSTRUCTION: discovered agent findings are `provenance:
 * "corpus-agent"`, `enforcement: "warn"` — they can never raise the blocking
 * count, so merging them can never flip the exit code. Metadata-only on the wire
 * is preserved: agent findings project through the same `toContractFinding` /
 * phone-home path as the deterministic floor, so no file/line ever crosses.
 */
import type { EnrichedFinding } from "./corpus";
import { createAnthropicProvider } from "./runner/providers/anthropic";
import { createCodeGraphLookup } from "./runner/codegraph-lookup";
import type { Provider } from "./runner/provider";
import { createSkillsReasoner } from "./runner/reasoning/skills-reasoner";
import { type RunnerConfig, runAgentLane } from "./runner/runner";

/** The provider ids this engine ships a concrete implementation for. */
const SHIPPED_PROVIDERS = new Set(["anthropic"]);

/**
 * Resolve the concrete {@link Provider} from the CI env, or `null` when the AI
 * lane should not run. Absence of `LLM_API_KEY` is the deterministic-floor
 * signal — NOT an error. `LLM_PROVIDER` (default `anthropic`) selects the
 * implementation; an unrecognized value degrades to `null` (floor only) rather
 * than throwing, keeping the wire-in non-blocking. `LLM_MODEL` overrides the
 * provider's default model.
 */
export function resolveProvider(env: NodeJS.ProcessEnv): Provider | null {
  const apiKey = env.LLM_API_KEY;
  if (apiKey === undefined || apiKey.trim() === "") return null;

  // Empty is treated as absent (→ default `anthropic`), same as LLM_MODEL below.
  // The GitHub Action plumbs LLM_PROVIDER with a `default: ""`, so a bare BYOK key
  // arrives with LLM_PROVIDER="" — an empty string that must not select "no provider".
  const providerId = ((env.LLM_PROVIDER ?? "").trim() || "anthropic").toLowerCase();
  if (!SHIPPED_PROVIDERS.has(providerId)) return null;

  const model = env.LLM_MODEL !== undefined && env.LLM_MODEL.trim() !== "" ? env.LLM_MODEL.trim() : undefined;
  // `LLM_TIMEOUT_MS` overrides the per-request abort bound (#2192); a bad value
  // stays `undefined` so the provider keeps its safe default — can't disable it.
  const timeoutMs = parseTimeoutMs(env.LLM_TIMEOUT_MS);
  return createAnthropicProvider({
    apiKey,
    ...(model !== undefined ? { model } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
}

/** Parse `LLM_TIMEOUT_MS` to a positive number of milliseconds, else `undefined` (use the provider default). */
function parseTimeoutMs(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** Seams the caller may override — the provider is injected in the tracer test. */
export interface AgentLaneOverrides {
  /**
   * Inject a provider directly, bypassing env resolution. When provided, the AI
   * lane runs with THIS provider (the key check is skipped). A test drives the
   * real `runCheck` end to end with a stub provider through this seam.
   */
  readonly provider?: Provider;
  readonly config?: RunnerConfig;
}

/**
 * Drive the AI lane over the deterministic findings and return the augmented
 * list: every deterministic finding (some now carrying an in-place `agentNote`)
 * followed by the DISCOVERED `corpus-agent` findings. When the AI lane does not
 * run — no key, unknown provider, or an override that is absent — the input list
 * is returned unchanged.
 *
 * NEVER throws: `runAgentLane` is already total, and the outer guard folds any
 * unexpected construction failure back to the deterministic floor. NEVER shrinks
 * the list: the returned `enrichedFindings` is the input in order, so the
 * deterministic floor always survives.
 */
export async function augmentWithAgentLane(
  findings: readonly EnrichedFinding[],
  root: string,
  env: NodeJS.ProcessEnv,
  overrides: AgentLaneOverrides = {},
): Promise<readonly EnrichedFinding[]> {
  const provider = overrides.provider ?? resolveProvider(env);
  if (provider === null) return findings;
  // Nothing to reason about — skip the lane entirely rather than spin it up.
  if (findings.length === 0) return findings;

  try {
    const reasoner = createSkillsReasoner();
    const lookup = createCodeGraphLookup({ root });
    // A human breadcrumb stamped on emitted agent findings; matches phone-home's
    // scope vocabulary. Not load-bearing for local SARIF/JSON render.
    const scope = env.B8E_SCOPE !== undefined && env.B8E_SCOPE.trim() !== "" ? env.B8E_SCOPE.trim() : "ci-diff";

    const outcome = await runAgentLane({
      findings,
      reasoner,
      provider,
      lookup,
      scope,
      ...(overrides.config !== undefined ? { config: overrides.config } : {}),
    });

    // `enrichedFindings` IS the deterministic floor in order (some with a note);
    // `findings` are the deduped agent discoveries. Concatenation merges the two
    // lanes into the one list every render path already handles.
    return [...outcome.enrichedFindings, ...outcome.findings];
  } catch {
    // Belt-and-suspenders: `runAgentLane` never rejects, but a construction
    // failure (lookup wiring, etc.) must still degrade to the deterministic
    // floor — the AI lane can never fail the run.
    return findings;
  }
}
