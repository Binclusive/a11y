import type { Graph, PlanRow } from "../schema.js";
import { type PlanAxis, rankPlan } from "../smells/plan.js";
import { stableStringify } from "./json.js";

/**
 * plan.ts — the `--plan` render (SPEC §10): ranked refactor targets under the
 * chosen `--by` axis. Human view is a table of the top 20; `--json` emits the
 * full `PlanRow[]`. The ranking itself lives in smells/plan.ts — the renderer
 * only re-ranks the graph's functions by the requested axis and formats.
 */

const HUMAN_LIMIT = 20;

/** One human row: id + coordinates + the numbers that drove the rank. */
function formatRow(row: PlanRow, index: number): string {
  const rank = String(index + 1).padStart(3, " ");
  const kinds = row.smells.map((s) => s.kind).join(",") || "—";
  return [
    `${rank}. ${row.id}`,
    `     ${row.file}:${row.startLine}-${row.endLine}`,
    `     loc=${row.loc} cx=${row.complexity} fanIn=${row.calledByCount ?? "—"} smells=${row.components.smells} score=${row.score}`,
    `     [${kinds}]`,
  ].join("\n");
}

function renderHuman(rows: PlanRow[], axis: PlanAxis): string {
  if (rows.length === 0) return `No refactor targets (--by ${axis}).`;
  const head = `Refactor plan — ranked by ${axis} (top ${Math.min(HUMAN_LIMIT, rows.length)} of ${rows.length})`;
  const body = rows
    .slice(0, HUMAN_LIMIT)
    .map((row, i) => formatRow(row, i))
    .join("\n");
  return `${head}\n${body}`;
}

export function renderPlan(graph: Graph, axis: PlanAxis, json: boolean, pretty: boolean): string {
  const rows = rankPlan(graph.functions, axis);
  if (json) {
    return stableStringify(rows, pretty);
  }
  return renderHuman(rows, axis);
}
