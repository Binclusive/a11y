import type { Graph } from "../schema.js";
import { stableStringify } from "./json.js";

/**
 * graph.ts — the `--graph` render (SPEC §10): the full Graph as JSON. Compact by
 * default (the large dump, on demand); `--pretty` indents.
 */
export function renderGraph(graph: Graph, pretty: boolean): string {
  return stableStringify(graph, pretty);
}
