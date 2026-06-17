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
} from "./corpus";
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
export {
  type ComponentSuggestion,
  type SuggestConfidence,
  type SuggestOptions,
  type SuggestResult,
  suggestComponentMap,
} from "./suggest";

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

// ── 4 · Corpus — the moat, read-only ─────────────────────────────────────────
export {
  type BaselineRuleInfo,
  baselineRules,
  type CorpusCriterion,
  type CorpusEvidence,
  type CorpusPattern,
  corpusBestPractice,
  corpusCriteria,
  corpusFix,
  corpusHelpUrl,
  corpusPatterns,
  corpusSeverity,
  corpusTier,
  type CorpusTier,
  type DistilledPatternRef,
} from "./corpus";
export { BLOCK_BEGIN, BLOCK_END, extractBlock, renderBlock, spliceBlock } from "./agents-block";
export {
  type RetrievedPattern,
  type RetrievedSlice,
  type RetrieveInput,
  retrieveSlice,
  SLICE_CAP,
} from "./retrieve";
export { RULE_ID_TO_WCAG, wcagForRuleId } from "./wcag-map";
