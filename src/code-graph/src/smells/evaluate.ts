import { distinctExternalCallers } from "../extract/edges.js";
import type { DirectoryNode, FunctionNode, ModuleNode, Smell, Thresholds } from "../schema.js";
import type { FunctionFacts } from "./rules.js";
import { RULES, smellKinds } from "./rules.js";

/**
 * evaluate.ts — run the RULES table over a node and return its smells, sorted
 * deterministically (SPEC §3). One place owns "for each rule, evaluate" so the
 * cheap-pass (Phase 2) and edge-dependent (Phase 3) rules flow through the same
 * loop; edge rules simply return [] until their data lands.
 *
 * Each rule returns a `RawSmell` (kind-less); here we stamp the OWNING RULES key
 * as the `kind`, so a rule can never mislabel its own smell and the kind always
 * matches the table key (SPEC §9 SSOT). This is also where the `SmellKind`
 * dependency lives — rules.ts stays free of it to avoid the derivation cycle.
 */

const KINDS = smellKinds();

/** Total order on smells: kind, then severity (high first), then value desc. */
function compareSmells(a: Smell, b: Smell): number {
  return (
    a.kind.localeCompare(b.kind) ||
    (a.severity === b.severity ? 0 : a.severity === "high" ? -1 : 1) ||
    b.value - a.value
  );
}

/**
 * Project a FunctionNode onto the structural FunctionFacts a rule reads. The
 * node carries one `edges` block (calls/calledBy/callChainDepth) — `null` in the
 * cheap pass. We thread `calledByCount`/`callChainDepth` from it, or `null` when
 * edges were not computed, so the edge rules get NO data (not measured-zero) and
 * emit nothing on a cheap-only run (SPEC §3).
 *
 * `calledByCount` is `distinctExternalCallers`, NOT `calledBy.length`: `calledBy`
 * holds one entry per call SITE, so a self-recursive function lists itself N times
 * (SPEC §8-C2). Fan-in is distinct callers excluding self, so `high-fan-in` fires
 * on real dependents, not on a function's own recursion.
 */
function factsFor(fn: FunctionNode): FunctionFacts {
  return {
    id: fn.id,
    file: fn.file,
    startLine: fn.startLine,
    loc: fn.loc,
    commentLines: fn.commentLines,
    nestingDepth: fn.nestingDepth,
    complexity: fn.complexity,
    calledByCount: fn.edges ? distinctExternalCallers(fn.id, fn.edges.calledBy) : null,
    callChainDepth: fn.edges ? fn.edges.callChainDepth : null,
  };
}

/** Evaluate every rule against one function node; sorted, deduped by §3. */
export function smellsForFunction(fn: FunctionNode, thresholds: Thresholds): Smell[] {
  const facts = factsFor(fn);
  const out: Smell[] = [];
  for (const kind of KINDS) {
    for (const raw of RULES[kind].evaluate({
      fn: facts,
      module: null,
      directory: null,
      thresholds,
    })) {
      out.push({ kind, ...raw });
    }
  }
  out.sort(compareSmells);
  return out;
}

/** Evaluate every rule against one module node; sorted by §3. */
export function smellsForModule(module: ModuleNode, thresholds: Thresholds): Smell[] {
  const out: Smell[] = [];
  for (const kind of KINDS) {
    for (const raw of RULES[kind].evaluate({ fn: null, module, directory: null, thresholds })) {
      out.push({ kind, ...raw });
    }
  }
  out.sort(compareSmells);
  return out;
}

/** Evaluate every rule against one directory node; sorted by §3 (SPEC §8-C4). */
export function smellsForDirectory(directory: DirectoryNode, thresholds: Thresholds): Smell[] {
  const out: Smell[] = [];
  for (const kind of KINDS) {
    for (const raw of RULES[kind].evaluate({ fn: null, module: null, directory, thresholds })) {
      out.push({ kind, ...raw });
    }
  }
  out.sort(compareSmells);
  return out;
}

/**
 * Total order on the flattened Graph.smells (SPEC §3): by target locator first
 * (so all smells for one place cluster), then kind/severity/value. The locator
 * is `file:startLine` for functions, `file` for modules, `dir` for directories.
 */
export function compareFlatSmells(a: Smell, b: Smell): number {
  const la = smellLocator(a);
  const lb = smellLocator(b);
  return la.localeCompare(lb) || compareSmells(a, b);
}

function smellLocator(s: Smell): string {
  const target = s.target;
  switch (target.type) {
    case "function":
      return `${target.file}:${String(target.startLine).padStart(8, "0")}`;
    case "module":
      return target.file;
    case "directory":
      return target.dir;
    default: {
      const exhaustive: never = target;
      return exhaustive;
    }
  }
}
