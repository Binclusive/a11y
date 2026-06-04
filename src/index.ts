export {
  BLOCK_BEGIN,
  BLOCK_END,
  extractBlock,
  renderBlock,
  slugify,
  spliceBlock,
} from "./agents-block";
export { collectTsx } from "./collect";
export {
  appendLearned,
  BLOCK_TARGETS,
  CONTRACT_FILE,
  type DriftEntry,
  type GenResult,
  gen,
  type InitResult,
  init,
  type LearnInput,
  type LearnResult,
  learn,
  loadContract,
} from "./commands";
export {
  commonBaseDir,
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
  type Stack,
  serializeContract,
} from "./contract";
export { checkFiles, type Finding, type FindingProvenance, type ScanResult, scan } from "./core";
export {
  type CorpusCriterion,
  type CorpusEvidence,
  type CorpusPattern,
  type CorpusTier,
  corpusCriteria,
  corpusPatterns,
  type DistilledPatternRef,
  type EnrichedFinding,
  enrich,
  enrichAll,
} from "./corpus";
export {
  detectDesignSystem,
  detectStack,
  packageNameOf,
} from "./detect-stack";
export {
  type DistilledPattern,
  type DropLedger,
  distill,
  type FrequencyTier,
  MIN_ORGS,
  type RawFinding,
  tierForOrgs,
} from "./distill/distill";
export {
  categorizeJourney,
  JOURNEY_CATEGORIES,
  type JourneyCategory,
} from "./distill/journey-category";
export { compareSC, normalizeCriterion } from "./distill/normalize-sc";
export {
  type ControlType,
  type EnforceContext,
  enforceContent,
} from "./enforce";
export {
  GUARANTEED_LIBRARIES,
  type GuaranteedLibrary,
  ICON_LIBRARIES,
  isIconLibrary,
  lookupGuaranteed,
  lookupRegistry,
  REGISTRY,
  type RegistryRule,
} from "./registry";
export {
  type ComponentResolution,
  type Coverage,
  type OpaqueKind,
  type Provenance,
  type ResolvedComponents,
  type ResolvedProvenance,
  resolveComponents,
} from "./resolve-components";
export {
  collectLocalImports,
  type ImportBinding,
  resolveRoute,
  type TraceResult,
  traceComponent,
} from "./source-trace";
export { RULE_ID_TO_WCAG, wcagForRuleId } from "./wcag-map";
export { resolveWorkspaceImport } from "./workspace-resolve";
