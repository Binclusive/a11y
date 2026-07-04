import type { Graph } from "../schema.js";
import { buildHtmlModel } from "./html-model.js";
import { renderPage } from "./html-template.js";

/**
 * html.ts -- the `--html` human-facing report (HTML-VIEW.md). NOT an agent
 * surface: it projects the agent-native `Graph` into a self-contained HTML page
 * (header + d3 hotspot treemap + cytoscape hub call-graph + sortable top-targets
 * table) that a person opens in a browser.
 *
 * The work is split across three files so each stays under the self-gate bar:
 *  - `html-model.ts`    -- the PURE `Graph -> HtmlModel` projection (unit-tested).
 *  - `html-template.ts` -- the static HTML/CSS/client-JS scaffold (a string).
 *  - this file          -- the thin CLI entry: build the model, render the page.
 *
 * The data is deterministic (sorted, SPEC §3); only fcose's pixel layout varies
 * run-to-run, which is fine for a human view and noted in the page footer.
 */

export type {
  GraphEdge,
  GraphNode,
  HtmlModel,
  Severity,
  TreemapNode,
} from "./html-model.js";
// Re-export the model surface so callers (and tests) import from one place.
export {
  buildHtmlModel,
  SEVERITY_COLOR,
} from "./html-model.js";

/**
 * Render the self-contained HTML report (HTML-VIEW §3): build the §4 model from
 * the graph, then assemble the page with `DATA` inlined and the d3/cytoscape CDN
 * scripts wired. No server, no build step -- redirect stdout to a file.
 */
export function renderHtml(graph: Graph): string {
  return renderPage(graph, buildHtmlModel(graph));
}
