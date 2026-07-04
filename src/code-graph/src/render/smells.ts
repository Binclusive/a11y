import type { Graph, Smell } from "../schema.js";
import { stableStringify } from "./json.js";

/**
 * smells.ts — the `--smells` render (SPEC §10): all smells grouped by kind.
 * Human view is a grouped table; `--json` emits the flat `Smell[]` (already
 * sorted deterministically by assemble.ts). The human view never invents data —
 * it only reformats `graph.smells`.
 */

/** A target's human locator: `file:line` for functions, `file`/`dir` otherwise. */
function locator(smell: Smell): string {
  const target = smell.target;
  switch (target.type) {
    case "function":
      return `${target.id} (${target.file}:${target.startLine})`;
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

function renderHuman(graph: Graph): string {
  if (graph.smells.length === 0) return "No smells found.";

  // Group by kind; kinds in sorted order so the report is stable.
  const byKind = new Map<string, Smell[]>();
  for (const s of graph.smells) {
    const arr = byKind.get(s.kind) ?? [];
    arr.push(s);
    byKind.set(s.kind, arr);
  }
  const kinds = Array.from(byKind.keys()).sort();

  const lines: string[] = [];
  for (const kind of kinds) {
    const group = byKind.get(kind) ?? [];
    lines.push(`${kind} (${group.length})`);
    for (const s of group) {
      lines.push(`  [${s.severity}] ${locator(s)}  value=${s.value} threshold=${s.threshold}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

export function renderSmells(graph: Graph, json: boolean, pretty: boolean): string {
  if (json) {
    return stableStringify(graph.smells, pretty);
  }
  return renderHuman(graph);
}
