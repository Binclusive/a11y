import chalk from "chalk";
import type { FunctionNode, Graph, ModuleNode } from "../schema.js";

/**
 * tree.ts — the `--tree` render (SPEC §10): an indented `file → function` view,
 * functions grouped under their module:
 *
 *   src/foo.ts  (loc 220, 8 fns)
 *     ├ parseThing        L12-48   loc=36 cx=8 nest=3  [high-complexity]
 *     └ handle            L50-61   loc=12 cx=2 nest=1
 *
 * Modules are sorted by `file`; functions within a module by `startLine` (§3
 * total order). Each function's smell kinds are appended inline. Test modules
 * are dimmed and suffixed `[test]` but never dropped — they still count as part
 * of the graph the agent is orienting in.
 *
 * Color comes from chalk, which auto-disables when stdout is not a TTY (piped
 * or redirected), so the output degrades to readable plain text on its own —
 * the §10 "plain when piped" requirement needs no extra branch here.
 *
 * `--json` is not meaningful for a tree view; the CLI never routes a JSON
 * request here (it falls back to the structured graph), so this renderer is
 * text-only by construction.
 */

/** Column width for the function name before the L-range, so ranges align. */
const NAME_COL = 20;

/** `parseThing` → smell suffix `  [high-complexity,deep-nesting]` or "". */
function smellSuffix(fn: FunctionNode): string {
  if (fn.smells.length === 0) return "";
  // Kinds in sorted order so the marker is stable run-to-run (§3).
  const kinds = fn.smells
    .map((s) => s.kind)
    .sort()
    .join(",");
  return `  ${chalk.yellow(`[${kinds}]`)}`;
}

/** One function line under its module, using the given branch glyph. */
function renderFunction(fn: FunctionNode, isLast: boolean): string {
  const glyph = isLast ? "└" : "├";
  const name = fn.name.padEnd(NAME_COL, " ");
  const range = `L${fn.startLine}-${fn.endLine}`.padEnd(10, " ");
  const metrics = `loc=${fn.loc} cx=${fn.complexity} nest=${fn.nestingDepth}`;
  const colored = fn.smells.length > 0 ? chalk.bold(name) : name;
  return `  ${glyph} ${colored}${range}${metrics}${smellSuffix(fn)}`;
}

/** Module header: `src/foo.ts  (loc 220, 8 fns)`, dimmed + `[test]` if a test. */
function renderModuleHeader(module: ModuleNode, fnCount: number): string {
  const head = `${module.file}  (loc ${module.loc}, ${fnCount} fns)`;
  if (module.isTest) return chalk.dim(`${head}  [test]`);
  return chalk.cyan(head);
}

export function renderTree(graph: Graph): string {
  if (graph.modules.length === 0) return "No modules in the graph.";

  // Functions indexed by file, each list sorted by startLine (§3 total order).
  const byFile = new Map<string, FunctionNode[]>();
  for (const fn of graph.functions) {
    const arr = byFile.get(fn.file) ?? [];
    arr.push(fn);
    byFile.set(fn.file, arr);
  }
  for (const arr of byFile.values()) {
    arr.sort((a, b) => a.startLine - b.startLine || a.name.localeCompare(b.name));
  }

  const modules = [...graph.modules].sort((a, b) => a.file.localeCompare(b.file));

  const lines: string[] = [];
  for (const module of modules) {
    const fns = byFile.get(module.file) ?? [];
    lines.push(renderModuleHeader(module, fns.length));
    fns.forEach((fn, i) => {
      lines.push(renderFunction(fn, i === fns.length - 1));
    });
  }
  return lines.join("\n");
}
