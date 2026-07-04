/**
 * `@binclusive/a11y` runner — the provider-agnostic AI lane (issue #2095).
 *
 * The harness that sits on top of the deterministic engine: a BYO-provider
 * abstraction + a capped, non-blocking pull loop that consumes the engine's
 * deterministic findings and emits agent-provenance findings through the SAME
 * metadata-only contract projection. The reasoning content (skills #2096,
 * code-graph lookups #2097, enrich/discover logic #2098) lives behind the
 * `AgentReasoner` and `LookupTool` seams — this surface owns none of it.
 */
export {
  type BudgetSnapshot,
  meterProvider,
  TokenCeilingExceeded,
  TokenLedger,
} from "./budget";
export {
  LookupCounter,
  type LookupQuery,
  type LookupResult,
  type LookupTool,
  meterLookup,
} from "./lookup";
export {
  type CodeGraphLookupConfig,
  type CodeGraphLookupData,
  type CodeGraphQueryKind,
  createCodeGraphLookup,
} from "./codegraph-lookup";
export {
  type Provider,
  type ProviderMessage,
  type ProviderRequest,
  type ProviderResponse,
  type TokenUsage,
  usageTotal,
} from "./provider";
export {
  type AgentFinding,
  type AgentReasoner,
  type ReasonContext,
} from "./reasoner";
export {
  DEFAULT_RUNNER_CONFIG,
  type PassOutcome,
  type PassReport,
  type RunInput,
  type RunnerConfig,
  type RunOutcome,
  runAgentLane,
} from "./runner";
