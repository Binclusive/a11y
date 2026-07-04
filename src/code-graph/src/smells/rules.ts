import type { SmellTarget, Thresholds } from "../schema.js";

/**
 * The keyed rule table is the SINGLE SOURCE OF TRUTH for smell kinds (SPEC §9).
 * `SmellKind` here is derived as `keyof typeof RULES` — adding a smell is the
 * only place a new kind is declared; the schema enum, evaluators, and renderers
 * follow.
 *
 * The CHEAP-PASS evaluators (long-function, deep-nesting, high-complexity,
 * dense-undocumented, big-file, AND directory-sprawl) read data already present
 * on the cheap-pass nodes — directory-sprawl needs only the per-directory file
 * count, no type info (SPEC §8-C4). The two EDGE-DEPENDENT smells (high-fan-in,
 * deep-call-chain) read `calledBy` / `callChainDepth`, which only exist once the
 * opt-in edge pass has run (SPEC §3); on a cheap-only run those fields are
 * empty/zero, so the rules naturally emit nothing.
 *
 * `Smell`-typed values are NOT constructed inside this file. Doing so would
 * force tsc to resolve `Smell → SmellKind → keyof typeof RULES` while RULES is
 * still being inferred — a type cycle. Each evaluator therefore returns a
 * structural `RawSmell` (its `kind` is a plain string); evaluate.ts stamps the
 * owning RULES key as the real `SmellKind` and parses the result into a `Smell`.
 * RULES stays the SSOT for kinds + thresholds + the evaluation logic (SPEC §9).
 */

/**
 * The function-node fields an evaluator reads. Structural (not the full
 * FunctionNode) so this file holds no type dependency on schema's node types.
 *
 * The two edge-derived fields are `number | null`: `null` = the edge pass did
 * not run (the function's `edges` block is null), so the call graph is UNKNOWN,
 * not measured-zero. The edge rules (high-fan-in, deep-call-chain) emit nothing
 * when their value is null — they have no data, so they make no claim.
 */
export type FunctionFacts = {
  id: string;
  file: string;
  startLine: number;
  loc: number;
  commentLines: number;
  nestingDepth: number;
  complexity: number;
  /** Edge pass (SPEC §8-C2): number of callers. `null` on a cheap-only run. */
  calledByCount: number | null;
  /** Edge pass (SPEC §8-C5): longest callee chain. `null` on a cheap-only run. */
  callChainDepth: number | null;
};

/** The module-node fields an evaluator reads. Structural, same reason. */
export type ModuleFacts = {
  file: string;
  loc: number;
};

/** The directory-node fields an evaluator reads (SPEC §8-C4). Cheap-pass. */
export type DirectoryFacts = {
  dir: string;
  fileCount: number;
};

/**
 * Everything an evaluator may read: the node it's judging plus the thresholds.
 * A function rule reads `fn`; a module rule reads `module`; a directory rule
 * reads `directory`. Exactly one node slot is non-null per call.
 */
export type RuleContext = {
  fn: FunctionFacts | null;
  module: ModuleFacts | null;
  directory: DirectoryFacts | null;
  thresholds: Thresholds;
};

/**
 * A measured smell, minus its `kind` — the kind is the owning RULES key, which
 * evaluate.ts supplies (so a rule can't mislabel itself) and parses into the
 * real `SmellKind`. Declared structurally (NOT `Omit<Smell, "kind">`): computing
 * `Omit<Smell, …>` would eagerly resolve `Smell → SmellKind → keyof typeof
 * RULES` and reform the derivation cycle. `SmellTarget` carries no SmellKind
 * dependency, so importing it is safe.
 */
export type RawSmell = {
  target: SmellTarget;
  value: number;
  threshold: number;
  severity: "warn" | "high";
};

export type Rule = {
  /**
   * Emit zero or one RawSmell for the given context. Cheap-pass rules read the
   * node metrics; edge-dependent rules read calledBy/callChainDepth, which are
   * empty until the opt-in edge pass runs. Pure + deterministic — no side
   * effects, no randomness. evaluate.ts stamps the kind (smell descriptions live
   * in SPEC §9, the single source).
   */
  evaluate: (ctx: RuleContext) => RawSmell[];
};

/** Severity ladder (SPEC §9): `high` when value is at least 2× the threshold. */
function severity(value: number, threshold: number): "warn" | "high" {
  return value >= 2 * threshold ? "high" : "warn";
}

export const RULES = {
  "long-function": {
    evaluate: ({ fn, thresholds }) => {
      if (!fn) return [];
      const t = thresholds.longFunctionLoc;
      if (fn.loc <= t) return [];
      return [
        {
          target: { type: "function", id: fn.id, file: fn.file, startLine: fn.startLine },
          value: fn.loc,
          threshold: t,
          severity: severity(fn.loc, t),
        },
      ];
    },
  },
  "deep-nesting": {
    evaluate: ({ fn, thresholds }) => {
      if (!fn) return [];
      const t = thresholds.deepNesting;
      if (fn.nestingDepth <= t) return [];
      return [
        {
          target: { type: "function", id: fn.id, file: fn.file, startLine: fn.startLine },
          value: fn.nestingDepth,
          threshold: t,
          severity: severity(fn.nestingDepth, t),
        },
      ];
    },
  },
  "high-complexity": {
    evaluate: ({ fn, thresholds }) => {
      if (!fn) return [];
      const t = thresholds.highComplexity;
      if (fn.complexity <= t) return [];
      return [
        {
          target: { type: "function", id: fn.id, file: fn.file, startLine: fn.startLine },
          value: fn.complexity,
          threshold: t,
          severity: severity(fn.complexity, t),
        },
      ];
    },
  },
  "dense-undocumented": {
    evaluate: ({ fn, thresholds }) => {
      if (!fn) return [];
      // Reuses highComplexity (SPEC §9): complex AND undocumented. The measured
      // value reported is complexity (what makes it dangerous).
      const t = thresholds.highComplexity;
      if (!(fn.complexity > t && fn.commentLines === 0)) return [];
      return [
        {
          target: { type: "function", id: fn.id, file: fn.file, startLine: fn.startLine },
          value: fn.complexity,
          threshold: t,
          severity: severity(fn.complexity, t),
        },
      ];
    },
  },
  "big-file": {
    evaluate: ({ module, thresholds }) => {
      if (!module) return [];
      const t = thresholds.bigFileLoc;
      if (module.loc <= t) return [];
      return [
        {
          target: { type: "module", file: module.file },
          value: module.loc,
          threshold: t,
          severity: severity(module.loc, t),
        },
      ];
    },
  },
  "high-fan-in": {
    evaluate: ({ fn, thresholds }) => {
      if (!fn) return [];
      // null = edges not computed → no data, no claim (cheap pass).
      if (fn.calledByCount === null) return [];
      const t = thresholds.highFanIn;
      if (fn.calledByCount <= t) return [];
      return [
        {
          target: { type: "function", id: fn.id, file: fn.file, startLine: fn.startLine },
          value: fn.calledByCount,
          threshold: t,
          severity: severity(fn.calledByCount, t),
        },
      ];
    },
  },
  "deep-call-chain": {
    evaluate: ({ fn, thresholds }) => {
      if (!fn) return [];
      // null = edges not computed → no data, no claim (cheap pass).
      if (fn.callChainDepth === null) return [];
      const t = thresholds.deepCallChain;
      if (fn.callChainDepth <= t) return [];
      return [
        {
          target: { type: "function", id: fn.id, file: fn.file, startLine: fn.startLine },
          value: fn.callChainDepth,
          threshold: t,
          severity: severity(fn.callChainDepth, t),
        },
      ];
    },
  },
  "directory-sprawl": {
    evaluate: ({ directory, thresholds }) => {
      if (!directory) return [];
      const t = thresholds.directorySprawl;
      if (directory.fileCount <= t) return [];
      return [
        {
          target: { type: "directory", dir: directory.dir },
          value: directory.fileCount,
          threshold: t,
          severity: severity(directory.fileCount, t),
        },
      ];
    },
  },
} satisfies Record<string, Rule>;

/** Derived SSOT for smell kinds (SPEC §5/§9). */
export type SmellKind = keyof typeof RULES;

/**
 * The keys of RULES as a NON-EMPTY tuple `[SmellKind, ...SmellKind[]]`.
 * TypeScript types `Object.keys` as `string[]` and genuinely cannot narrow it to
 * the literal key union — this is the ONE place that cast lives. Every consumer
 * (schema's `z.enum`, the evaluate loop) calls this instead of re-casting
 * `Object.keys(RULES)` at each site. The tuple type is what `z.enum` requires, so
 * schema.ts can pass the result straight through with no second cast.
 */
export function smellKinds(): [SmellKind, ...SmellKind[]] {
  return Object.keys(RULES) as [SmellKind, ...SmellKind[]];
}
