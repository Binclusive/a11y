import path from "node:path";
import type { FunctionNode, Graph, ModuleNode } from "../schema.js";
import { stableStringify } from "./json.js";

/**
 * file.ts — the `--file <f>` render (SPEC §10): one module plus its functions.
 * Warns (to stderr, via the returned `warning`) if `<f>` is in parseFailures or
 * was not found. The path is normalized to analyzed-root-relative POSIX so it
 * matches the graph's `file` keys regardless of how the user typed it.
 */

export type FileRender = {
  /** JSON payload for stdout (the module + its functions), or null if missing. */
  stdout: string | null;
  /** A warning for stderr, or null. */
  warning: string | null;
};

/**
 * Normalize a user-supplied path to the analyzed-root-relative POSIX form the
 * graph uses for its `file` keys. The target is resolved against cwd (so the
 * user may pass it however they like) and then re-expressed relative to the
 * analyzed root — the same base the graph's keys use.
 */
function normalize(rootAbsolute: string, target: string): string {
  const abs = path.resolve(target);
  const rel = path.relative(rootAbsolute, abs);
  return rel.split(path.sep).join("/");
}

export function renderFile(
  graph: Graph,
  rootAbsolute: string,
  target: string,
  pretty: boolean,
): FileRender {
  const wanted = normalize(rootAbsolute, target);
  // Also accept a match against the graph's own `file` keys directly (the user
  // may have passed exactly the analyzed-root-relative path already).
  const matches = (f: string): boolean => f === wanted || f === target;

  if (graph.summary.parseFailures.some(matches)) {
    return {
      stdout: null,
      warning: `warning: ${wanted} failed to parse and was excluded from the graph.`,
    };
  }

  const module: ModuleNode | undefined = graph.modules.find((m) => matches(m.file));
  if (!module) {
    return {
      stdout: null,
      warning: `warning: ${wanted} is not in the analyzed graph (no such module).`,
    };
  }

  const functions: FunctionNode[] = graph.functions.filter((fn) => fn.file === module.file);
  // Each function's `edges` block is self-describing: `null` in the cheap pass
  // (call graph not computed), a populated object in the edge pass. Provenance is
  // still carried for the run-level pass label, but `edges: null` already tells
  // the consumer the edges weren't measured — no `calledBy: []` leak to misread.
  const payload = { provenance: graph.provenance, module, functions };
  return {
    stdout: stableStringify(payload, pretty),
    warning: null,
  };
}
