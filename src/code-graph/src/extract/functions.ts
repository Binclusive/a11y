import { Node, type SourceFile } from "ts-morph";
import type { FunctionKind } from "../schema.js";
import { toRelative } from "./project.js";

/**
 * functions.ts — enumerate NAMED CALLABLES only (SPEC §6-A1), resolve stable
 * names (A2), and build the ts-morph Node → FunctionNode.id map (§3) that every
 * later phase (edges) reuses instead of re-matching line numbers.
 *
 * Included callables: function declarations, class methods, constructors,
 * get/set accessors, and arrow / function-expressions ASSIGNED to a name
 * (variable, property assignment, class property). Anonymous inline callbacks
 * (`arr.map(x => …)`) are excluded from the list — but their nodes still belong
 * to the enclosing function's lexical body, so metrics.ts counts them toward the
 * enclosing function's nestingDepth/complexity.
 */

/** A discovered callable, before metrics are attached. */
export type DiscoveredFunction = {
  /** The ts-morph node — kept for the metrics walk and node→id map. */
  node: Node;
  id: string;
  name: string;
  kind: FunctionKind;
  file: string; // relative to the analyzed root (join with graph.root for absolute)
  startLine: number;
  endLine: number;
  isExported: boolean;
  isTest: boolean;
};

export type FunctionDiscovery = {
  functions: DiscoveredFunction[];
  /** Node → FunctionNode.id (§3). Reused by the edge pass. */
  nodeToId: Map<Node, string>;
};

const TEST_FILE = /\.(test|spec)\.tsx?$/;

/** SSOT for the `isTest` tag — used here and by assemble.ts (one definition). */
export function isTestFile(file: string): boolean {
  return TEST_FILE.test(file);
}

/** A2: derive the name for an arrow / function-expression from its binding. */
function nameFromBinding(node: Node): string | null {
  const parent = node.getParent();
  if (!parent) return null;
  if (Node.isVariableDeclaration(parent)) return parent.getName();
  if (Node.isPropertyAssignment(parent)) return parent.getName();
  if (Node.isPropertyDeclaration(parent)) return parent.getName();
  // `export default () => …` — name it by the default-export convention.
  if (Node.isExportAssignment(parent)) return "default";
  return null;
}

/** A classified named callable: its kind + resolved name. */
type Classified = { kind: FunctionKind; name: string };

/**
 * Classify a function declaration. Overload signatures and ambient `declare
 * function` have no body — only the IMPLEMENTATION (the one with a body) is
 * enumerated, so a caller resolves to the real function (not a phantom `loc:1`
 * first signature) and ambient stubs become honest `external:*` calls. An
 * anonymous `export default function(){}` takes the default-export name.
 */
function classifyFunctionDeclaration(node: Node): Classified | null {
  if (!Node.isFunctionDeclaration(node)) return null;
  if (node.isOverload() || !node.hasBody()) return null;
  const name = node.getName();
  if (name) return { kind: "function", name };
  return node.isDefaultExport() ? { kind: "function", name: "default" } : null;
}

/**
 * Classify class members (method, constructor, get/set accessor). Methods skip
 * overload signatures and bodyless decls (ambient classes / interface impls),
 * keeping the implementation; accessors and constructors always have a body.
 */
function classifyClassMember(node: Node): Classified | null {
  if (Node.isMethodDeclaration(node)) {
    if (node.isOverload() || !node.hasBody()) return null;
    return { kind: "method", name: node.getName() };
  }
  if (Node.isConstructorDeclaration(node)) return { kind: "constructor", name: "constructor" };
  if (Node.isGetAccessorDeclaration(node)) return { kind: "getter", name: node.getName() };
  if (Node.isSetAccessorDeclaration(node)) return { kind: "setter", name: node.getName() };
  return null;
}

/**
 * Classify an arrow / function-expression — listed only when it resolves to a
 * name (A2). A named function expression (`const x = function foo(){}`) keeps
 * its own name; otherwise it takes the binding name.
 */
function classifyExpressionCallable(node: Node): Classified | null {
  if (Node.isArrowFunction(node)) {
    const name = nameFromBinding(node);
    return name ? { kind: "arrow", name } : null;
  }
  if (Node.isFunctionExpression(node)) {
    const name = node.getName() ?? nameFromBinding(node);
    return name ? { kind: "function-expression", name } : null;
  }
  return null;
}

/**
 * Classify a node as a named callable per A1/A2. Returns its kind + resolved
 * name, or null if the node is not a callable we list (e.g. anonymous callback,
 * or any non-callable node). Each callable family is its own classifier.
 */
function classify(node: Node): Classified | null {
  return (
    classifyFunctionDeclaration(node) ??
    classifyClassMember(node) ??
    classifyExpressionCallable(node)
  );
}

/**
 * Is this declaration exported? For function declarations, methods, and class
 * properties, `isExported()` on the Exportable node is authoritative. Arrows /
 * fn-expressions are handled in `callableIsExported` (export lives on the
 * variable statement, not the expression).
 */
function isExported(node: Node): boolean {
  if (Node.isExportable(node)) return node.isExported();
  return false;
}

/** For an arrow/fn-expression, export status is on the variable statement. */
function callableIsExported(node: Node, classified: FunctionKind): boolean {
  if (classified === "arrow" || classified === "function-expression") {
    const parent = node.getParent();
    if (parent && Node.isExportAssignment(parent)) return true;
    if (parent && Node.isVariableDeclaration(parent)) {
      const stmt = parent.getVariableStatement();
      return stmt ? stmt.isExported() : false;
    }
    if (parent && Node.isPropertyDeclaration(parent)) return isExported(parent);
    return false;
  }
  return isExported(node);
}

/**
 * Walk one source file, emitting every named callable in source order. Builds
 * the node→id map. Within-file `id` collisions are resolved by a stable
 * occurrence ordinal (`#0`, `#1`, … in source order) — A2.
 */
function discoverInFile(
  rootAbsolute: string,
  sourceFile: SourceFile,
  nodeToId: Map<Node, string>,
): DiscoveredFunction[] {
  const file = toRelative(rootAbsolute, sourceFile.getFilePath());
  const isTest = isTestFile(file);

  // First gather raw (node, name, kind) in source order so ordinals are stable.
  const raw: { node: Node; name: string; kind: FunctionKind }[] = [];
  sourceFile.forEachDescendant((node) => {
    const c = classify(node);
    if (c) raw.push({ node, name: c.name, kind: c.kind });
  });

  // Resolve ids: base id is `${file}:${name}`; on collision within the file,
  // every colliding occurrence gets `#ordinal` in source order.
  const baseIdCounts = new Map<string, number>();
  for (const r of raw)
    baseIdCounts.set(`${file}:${r.name}`, (baseIdCounts.get(`${file}:${r.name}`) ?? 0) + 1);
  const ordinalSeen = new Map<string, number>();

  const out: DiscoveredFunction[] = [];
  for (const r of raw) {
    const base = `${file}:${r.name}`;
    let id = base;
    if ((baseIdCounts.get(base) ?? 0) > 1) {
      const ord = ordinalSeen.get(base) ?? 0;
      ordinalSeen.set(base, ord + 1);
      id = `${base}#${ord}`;
    }
    nodeToId.set(r.node, id);
    out.push({
      node: r.node,
      id,
      name: r.name,
      kind: r.kind,
      file,
      startLine: r.node.getStartLineNumber(),
      endLine: r.node.getEndLineNumber(),
      isExported: callableIsExported(r.node, r.kind),
      isTest,
    });
  }
  return out;
}

/** Discover all named callables across the loaded source files (§6-A1/A2). */
export function discoverFunctions(
  rootAbsolute: string,
  sourceFiles: SourceFile[],
): FunctionDiscovery {
  const nodeToId = new Map<Node, string>();
  const functions: DiscoveredFunction[] = [];
  for (const sf of sourceFiles) {
    functions.push(...discoverInFile(rootAbsolute, sf, nodeToId));
  }
  // Determinism (§3): sort by (file, startLine, name), then `id` as the final
  // unique tiebreak. `id` carries the `#ordinal` on collision, so it's unique —
  // ties (a getter+setter of the same name on the same line; two methods on one
  // line) get a DEFINED order, not one that's stable only by V8's sort luck.
  functions.sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.startLine - b.startLine ||
      a.name.localeCompare(b.name) ||
      a.id.localeCompare(b.id),
  );
  return { functions, nodeToId };
}
