/**
 * `@binclusive/a11y` runner — the provider-agnostic AI lane (issue #2095).
 *
 * The harness that sits on top of the deterministic engine: a BYO-provider
 * abstraction + a capped, non-blocking pull loop that consumes the engine's
 * deterministic findings and emits agent-provenance findings through the SAME
 * metadata-only contract projection. The code-graph lookups (#2097) and the
 * enrich/discover deepening (#2098) still live behind the `LookupTool` seam and
 * the reasoner's response parse. The reasoning CORE (#2096) — the ported
 * per-framework checklists + pattern catalog and the concrete `AgentReasoner`
 * that consults them — now fills the reasoning seam (`./reasoning`).
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
export {
  type ChecklistArea,
  type FixSeverity,
  type FixSuggestion,
  type FixType,
  FIX_TYPES,
  type FrameworkGuidance,
  frameworkGuidanceFor,
  type PatternCatalogEntry,
  REACT_GUIDANCE,
} from "./reasoning";
export {
  createSkillsReasoner,
  type SkillsReasonerOptions,
} from "./reasoning/skills-reasoner";
export {
  buildSystemPrompt,
  buildUserPrompt,
  parseSuggestions,
  suggestionMessage,
} from "./reasoning/prompt";
