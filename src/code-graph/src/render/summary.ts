import type { Graph } from "../schema.js";
import { stableStringify } from "./json.js";

/**
 * summary.ts — the default render (SPEC §10): the Summary block as JSON. The
 * orientation output an agent reads first; never the full graph.
 */
export function renderSummary(graph: Graph, pretty: boolean): string {
  return stableStringify(graph.summary, pretty);
}
