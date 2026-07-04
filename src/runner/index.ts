/**
 * `@binclusive/a11y` runner — the provider-agnostic AI lane (issue #2095).
 *
 * The harness that sits on top of the deterministic engine: a BYO-provider
 * abstraction + a capped, non-blocking pull loop that consumes the engine's
 * deterministic findings and emits agent-provenance findings through the SAME
 * metadata-only contract projection. The code-graph lookups (#2097) live behind
 * the `LookupTool` seam. The reasoning CORE (#2096) — the ported per-framework
 * checklists + pattern catalog and the concrete `AgentReasoner` — fills the
 * reasoning seam (`./reasoning`). The enrich/discover deepening (#2098) is now
 * FILLED: the reasoner returns a `ReasonResult` (in-place enrichment + discovered
 * findings), parsed at a tolerant zod boundary and deduped against the floor.
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
  EMPTY_RESULT,
  type ReasonContext,
  type ReasonResult,
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
  type Discovery,
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
  type ParsedReasonResponse,
  parseReasonResponse,
  suggestionMessage,
} from "./reasoning/prompt";
