import { z } from "zod";
import { smellKinds } from "./smells/rules.js";

/**
 * schema.ts is THE CONTRACT (SPEC §5). Single sources of truth:
 *  - Threshold DEFAULTS live only here via `.default(n)`. The default object is
 *    `ThresholdsSchema.parse({})`; there is no second copy.
 *  - `SmellKind` is derived from the RULES keyed table (`keyof typeof RULES`).
 *    The kind enum below is built from those same keys, so rules.ts and the
 *    schema cannot drift.
 */

// --- SmellKind enum, derived from RULES (no hand-authored second union) ---
// `smellKinds()` (rules.ts) is the ONE place `Object.keys(RULES)` is cast to the
// literal-key tuple; we pass its result straight to `z.enum`, so the enum cannot
// drift from the rule table and there is no second `Object.keys` + cast here.
export const SmellKindSchema = z.enum(smellKinds());

// --- Thresholds: the only home for default values (SPEC §5) ---
// `.strict()` so an UNKNOWN key is a parse error, not silently stripped — this
// is what makes a typo'd `--thresholds` override a clean error (SPEC §10), since
// `ThresholdsSchema.partial()` inherits the strict unknown-key rejection.
// Each threshold is a count — a non-negative integer. `.int().nonnegative()` so a
// negative (`-5`) or fractional (`3.7`) override is a parse error (SPEC §5: wrong
// values are caught at the boundary, not silently corrupting the smell rules).
export const ThresholdsSchema = z
  .object({
    longFunctionLoc: z.number().int().nonnegative().default(60),
    deepNesting: z.number().int().nonnegative().default(4),
    highComplexity: z.number().int().nonnegative().default(10),
    bigFileLoc: z.number().int().nonnegative().default(400),
    highFanIn: z.number().int().nonnegative().default(10),
    deepCallChain: z.number().int().nonnegative().default(5),
    directorySprawl: z.number().int().nonnegative().default(10),
  })
  .strict();
export type Thresholds = z.infer<typeof ThresholdsSchema>;

// --- SmellTarget: tagged union, directly addressable (SPEC §5) ---
export const SmellTargetSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("function"),
    id: z.string(),
    file: z.string(),
    startLine: z.number(),
  }),
  z.object({ type: z.literal("module"), file: z.string() }),
  z.object({ type: z.literal("directory"), dir: z.string() }),
]);
export type SmellTarget = z.infer<typeof SmellTargetSchema>;

export const SmellSchema = z.object({
  kind: SmellKindSchema,
  target: SmellTargetSchema,
  value: z.number(),
  threshold: z.number(),
  severity: z.enum(["warn", "high"]),
});
export type Smell = z.infer<typeof SmellSchema>;

export const FunctionKindSchema = z.enum([
  "function",
  "method",
  "constructor",
  "getter",
  "setter",
  "arrow",
  "function-expression",
]);
export type FunctionKind = z.infer<typeof FunctionKindSchema>;

export const CallSiteSchema = z.object({
  calleeId: z.string(),
  line: z.number(),
});
export type CallSite = z.infer<typeof CallSiteSchema>;

export const CallerSiteSchema = z.object({
  callerId: z.string(),
  line: z.number(),
});
export type CallerSite = z.infer<typeof CallerSiteSchema>;

// --- Edges: the three call-graph fields live or die TOGETHER (SPEC §5) ---
// They are computed in one pass; a consumer must never see one real and the
// others stubbed. So they are ONE block: `edges: EdgesSchema.nullable()`, where
// `null` = the edge pass did not run (cheap pass) and a populated object = all
// three are real. This is the honest-states shape — there is no `calls: []` /
// `callChainDepth: 0` that reads as "measured leaf, isolated" when edges were
// never computed (the same lie the nullable `PlanRow.fanIn` already killed).
export const EdgesSchema = z.object({
  calls: z.array(CallSiteSchema),
  calledBy: z.array(CallerSiteSchema),
  callChainDepth: z.number(),
});
export type Edges = z.infer<typeof EdgesSchema>;

export const FunctionNodeSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: FunctionKindSchema,
  file: z.string(), // relative to the analyzed root (join with graph.root for absolute)
  startLine: z.number(),
  endLine: z.number(),
  loc: z.number(),
  commentLines: z.number(),
  nestingDepth: z.number(),
  complexity: z.number(),
  isExported: z.boolean(),
  isTest: z.boolean(),
  // null in the cheap pass (edges not computed); a populated block in the edge
  // pass, where calls/calledBy/callChainDepth are all real together.
  edges: EdgesSchema.nullable(),
  smells: z.array(SmellSchema),
});
export type FunctionNode = z.infer<typeof FunctionNodeSchema>;

export const ModuleNodeSchema = z.object({
  file: z.string(), // relative to the analyzed root (join with graph.root for absolute)
  loc: z.number(),
  commentLines: z.number(),
  functionIds: z.array(z.string()),
  imports: z.array(z.string()),
  importedBy: z.array(z.string()),
  isTest: z.boolean(),
  smells: z.array(SmellSchema),
});
export type ModuleNode = z.infer<typeof ModuleNodeSchema>;

export const DirectoryNodeSchema = z.object({
  dir: z.string(), // directory relative to the analyzed root
  fileCount: z.number(),
  functionCount: z.number(),
  files: z.array(z.string()),
  smells: z.array(SmellSchema),
});
export type DirectoryNode = z.infer<typeof DirectoryNodeSchema>;

export const PlanRowSchema = z.object({
  id: z.string(),
  file: z.string(),
  startLine: z.number(),
  endLine: z.number(),
  score: z.number(),
  // fanIn / calledByCount are `null` (not 0) when the edge pass did not run
  // (`provenance.pass === "cheap"`): the call graph is UNKNOWN, not measured-zero.
  // This is the honest-states fix (Nullable Is Two Functions) — a consumer must
  // not read 0 as "uncalled" when edges simply weren't computed.
  components: z.object({
    smells: z.number(),
    complexity: z.number(),
    fanIn: z.number().nullable(),
  }),
  loc: z.number(),
  complexity: z.number(),
  calledByCount: z.number().nullable(),
  smells: z.array(SmellSchema),
});
export type PlanRow = z.infer<typeof PlanRowSchema>;

export const ProvenanceSchema = z.discriminatedUnion("pass", [
  z.object({ pass: z.literal("cheap") }),
  z.object({
    pass: z.literal("edges"),
    tsConfig: z.string(),
    scope: z.enum(["package", "deep"]),
  }),
]);
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const SummarySchema = z.object({
  health: z.enum(["healthy", "rough", "rotten"]),
  fileCount: z.number(),
  functionCount: z.number(),
  smellCount: z.number(),
  highSeverityCount: z.number(),
  worstFile: z.string().nullable(),
  worstFunction: z.string().nullable(),
  topTargets: z.array(PlanRowSchema),
  parseFailures: z.array(z.string()),
});
export type Summary = z.infer<typeof SummarySchema>;

export const GraphSchema = z.object({
  root: z.string(),
  provenance: ProvenanceSchema,
  thresholds: ThresholdsSchema,
  summary: SummarySchema,
  functions: z.array(FunctionNodeSchema),
  modules: z.array(ModuleNodeSchema),
  directories: z.array(DirectoryNodeSchema),
  smells: z.array(SmellSchema),
  stats: z.object({
    fileCount: z.number(),
    functionCount: z.number(),
    totalLoc: z.number(),
    totalCommentLines: z.number(),
    smellCount: z.number(),
    parseFailures: z.array(z.string()),
  }),
});
export type Graph = z.infer<typeof GraphSchema>;
