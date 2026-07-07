/**
 * `@binclusive/a11y` — the engine library surface.
 *
 * The curated public API (see `docs/ENGINE-API.md`): the functions a CLI
 * (`b8e`, a lean shim) and agents call, organized into four clusters —
 * Scan, Contract lifecycle, Agent integration, Corpus.
 *
 * Engine INTERNALS are deliberately NOT re-exported here: component resolution,
 * source tracing, the registry, module-scope, workspace/tsconfig resolution,
 * the enforce pass, and the `distill/` corpus build-tool. They are implementation,
 * not contract — import them by path if you're working inside the engine.
 */

// ── 1 · Scan & enrich — the read path ────────────────────────────────────────
export { collectTsx } from "./collect";
export {
  type DiffScopeInput,
  parseChangedFiles,
  scopeChangedTsx,
  scopeChangedTsxFromEnv,
} from "./diff-scope";
export {
  checkFiles,
  dedupeRecall,
  type Finding,
  type FindingLayer,
  type FindingProvenance,
  type ScanResult,
  scan,
} from "./core";
export { type DomScanOptions, type DomScanResult, scanUrl } from "./collect-dom";
export { type SwiftScanResult, scanSwift } from "./collect-swift";
export {
  type DisplayContract,
  type EnrichedFinding,
  enrich,
  enrichAll,
  resolveDisplay,
} from "./evidence";
// Types that `ScanResult` and the CLI presentation reference (the functions that
// produce them — `resolveComponents` — stay internal):
export {
  type ComponentResolution,
  type Coverage,
  type OpaqueKind,
  type Provenance,
  type ResolvedComponents,
  type ResolvedProvenance,
} from "./resolve-components";

// ── 2 · Contract lifecycle — init / config ──────────────────────────────────
export {
  BLOCK_TARGETS,
  CONTRACT_FILE,
  type DriftEntry,
  type GenResult,
  gen,
  type InitOptions,
  type InitResult,
  init,
  type LearnInput,
  type LearnResult,
  learn,
  loadContract,
} from "./commands";
export {
  contractForFiles,
  type EnforcementLevel,
  enforcementFor,
  fileIgnoreMatcher,
  findContractFrom,
  ignoredRuleIds,
} from "./config-scan";
export {
  CONTRACT_VERSION,
  type Contract,
  ContractParseError,
  type Declarations,
  defaultEnforcement,
  type Enforcement,
  emptyDeclarations,
  type Language,
  type LearnedRule,
  parseContract,
  type Router,
  serializeContract,
  type Stack,
} from "./contract";
export { detectStack } from "./detect-stack";
// Emit path — the metadata-only wire projection (local finding -> contract) and
// the LOCAL SARIF renderer that reads the rich model directly. Both narrow
// through the ONE `evidenceImpact` accessor + `impactToLevel` (impact -> SARIF).
export {
  type LenientPayload,
  toContractFinding,
  toContractProvenance,
  toFindingPayload,
  toFindingPayloadLenient,
} from "./emit-contract";
export {
  diskLineSource,
  isPageFinding,
  type LineSource,
  lineContentHash,
  type LocationOptions,
  normalizeLine,
  resolveLocations,
} from "./source-identity";
export { formatSarif, impactToLevel } from "./sarif";
export {
  type ComponentSuggestion,
  type SuggestConfidence,
  type SuggestOptions,
  type SuggestResult,
  suggestComponentMap,
} from "./suggest";

// Provider-agnostic AI-lane runner (#2095): BYO provider + the capped,
// non-blocking pull loop. Reasoning content (skills/lookups/finding logic) is
// injected through the AgentReasoner + LookupTool seams (#2096/#2097/#2098).
export {
  type AgentFinding,
  type AgentReasoner,
  type BudgetSnapshot,
  type CodeGraphLookupConfig,
  type CodeGraphLookupData,
  type CodeGraphQueryKind,
  createCodeGraphLookup,
  DEFAULT_RUNNER_CONFIG,
  LookupCounter,
  type LookupQuery,
  type LookupResult,
  isMeterableUsage,
  type LookupTool,
  meterLookup,
  meterProvider,
  type PassOutcome,
  type PassReport,
  type Provider,
  type ProviderMessage,
  type ProviderRequest,
  type ProviderResponse,
  type ReasonContext,
  type RunInput,
  runAgentLane,
  type RunnerConfig,
  type RunOutcome,
  TokenCeilingExceeded,
  TokenLedger,
  type TokenUsage,
  usageTotal,
} from "./runner";

// ── 3 · Agent integration — hook + MCP ──────────────────────────────────────
export { type HookOutput, runHook } from "./hook";
export {
  buildServer,
  type CheckA11yResult,
  type CheckFinding,
  type CheckUrlResult,
  checkA11y,
  checkUrl,
  type GetA11yRulesResult,
  getA11yRules,
  type LearnA11yRuleResult,
  learnA11yRule,
  startStdioServer,
} from "./mcp";

// ── 4 · Evidence — the coverage catalog (axe baseline), read-only ────────────
// The corpus left the engine (ADR 0041 §G): pure detection, baseline everywhere.
export {
  type AxeImpact,
  type BaselineRuleInfo,
  baselineRules,
  type Evidence,
  evidenceBestPractice,
  evidenceFix,
  evidenceHelpUrl,
  evidenceImpact,
} from "./evidence";
export { BLOCK_BEGIN, BLOCK_END, extractBlock, renderBlock, spliceBlock } from "./agents-block";
export { RULE_ID_TO_WCAG, wcagForRuleId } from "./wcag-map";
