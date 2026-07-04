import { Node, type SourceFile, SyntaxKind } from "ts-morph";
import { toRelative } from "./project.js";

/**
 * metrics.ts — ONE AST walk per function (SPEC §7) computing loc, commentLines,
 * nestingDepth, complexity; plus per-file comment-line totals (§6-A4).
 *
 * The four metrics:
 *  - B1 loc        = endLine − startLine + 1. JSDoc is already excluded from the
 *                    declaration start; leading `//` comments don't count.
 *  - A4 commentLines = distinct physical lines spanned by the function's leading
 *                    comment ranges PLUS comment ranges (leading AND trailing)
 *                    inside its span, deduped. Trailing `// x` after code counts
 *                    too — without it a fully-commented branch reads as 0.
 *                    `getLeadingCommentRanges()` already includes JSDoc — we do
 *                    NOT also add getJsDocs() (that double-counts).
 *  - B2 nestingDepth = max block-nesting within this function's own body. Depth
 *                    accounting STOPS at a named-callable boundary: a nested
 *                    named function is its own node, so it doesn't inflate the
 *                    parent. Only anonymous inline callbacks contribute.
 *  - B3 complexity = 1 + count of decision tokens (exact list below).
 */

export type FunctionMetrics = {
  loc: number;
  commentLines: number;
  nestingDepth: number;
  complexity: number;
};

/** B3 decision-point kinds that add 1 each (control flow). */
const COMPLEXITY_STATEMENT_KINDS = new Set<SyntaxKind>([
  SyntaxKind.IfStatement,
  SyntaxKind.ConditionalExpression, // ternary
  SyntaxKind.ForStatement,
  SyntaxKind.ForInStatement,
  SyntaxKind.ForOfStatement,
  SyntaxKind.WhileStatement,
  SyntaxKind.DoStatement,
  SyntaxKind.CaseClause, // each case, NOT default
  SyntaxKind.CatchClause,
]);

/** B3 binary/short-circuit tokens that add 1 each: && || ?? */
const COMPLEXITY_BINARY_TOKENS = new Set<SyntaxKind>([
  SyntaxKind.AmpersandAmpersandToken,
  SyntaxKind.BarBarToken,
  SyntaxKind.QuestionQuestionToken,
]);

/** Class members that are always A1 boundaries (their own FunctionNode). */
const CLASS_MEMBER_BOUNDARY_KINDS = new Set<SyntaxKind>([
  SyntaxKind.MethodDeclaration,
  SyntaxKind.Constructor,
  SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor,
]);

/** Parent kinds that BIND an arrow/fn-expression to a name (making it an A1 boundary). */
const BINDING_PARENT_KINDS = new Set<SyntaxKind>([
  SyntaxKind.VariableDeclaration,
  SyntaxKind.PropertyAssignment,
  SyntaxKind.PropertyDeclaration,
  SyntaxKind.ExportAssignment,
]);

/** Statement kinds whose body adds one level of nesting depth (B2). */
const DEPTH_INCREASING_KINDS = new Set<SyntaxKind>([
  SyntaxKind.ForStatement,
  SyntaxKind.ForInStatement,
  SyntaxKind.ForOfStatement,
  SyntaxKind.WhileStatement,
  SyntaxKind.DoStatement,
  SyntaxKind.SwitchStatement,
  SyntaxKind.CatchClause,
]);

/** Is an arrow/fn-expression bound to a name (so it's its own A1 boundary)? */
function isBoundExpressionCallable(node: Node): boolean {
  const parent = node.getParent();
  if (!parent) return false;
  if (BINDING_PARENT_KINDS.has(parent.getKind())) return true;
  return Node.isFunctionExpression(node) && node.getName() !== undefined;
}

/**
 * Is `node` a named callable (an A1 boundary)? Used to stop the metrics walk so
 * a nested named function doesn't inflate its parent's depth/complexity.
 */
function isNamedCallableBoundary(node: Node): boolean {
  if (Node.isFunctionDeclaration(node)) return node.getName() !== undefined;
  if (CLASS_MEMBER_BOUNDARY_KINDS.has(node.getKind())) return true;
  if (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) {
    return isBoundExpressionCallable(node);
  }
  return false;
}

/** Does descending into `node` increase nesting depth (B2)? */
function isDepthIncreasing(node: Node): boolean {
  if (Node.isBlock(node)) {
    const parent = node.getParent();
    return parent !== undefined && Node.isIfStatement(parent);
  }
  if (DEPTH_INCREASING_KINDS.has(node.getKind())) return true;
  // Anonymous-callback body: an arrow/fn-expression that is NOT a named-callable
  // boundary contributes to the enclosing function's depth.
  if (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) {
    return !isNamedCallableBoundary(node);
  }
  return false;
}

/**
 * The single per-function walk. Recurses the function body, summing complexity
 * tokens and tracking max nesting depth, but PRUNES at any nested named-callable
 * boundary (so it owns only its own lexical body).
 */
function walkBody(fnNode: Node): { complexity: number; nestingDepth: number } {
  let complexity = 1; // B3 base
  let maxDepth = 0;

  function recurse(node: Node, depth: number): void {
    node.forEachChild((child) => {
      // Stop at a nested named callable: it's its own FunctionNode.
      if (isNamedCallableBoundary(child)) return;

      const kind = child.getKind();
      // The && / || / ?? operators surface as their own token nodes in the
      // child walk (QuestionQuestionToken etc.), so counting them by kind here
      // is sufficient — do NOT also inspect BinaryExpression.getOperatorToken(),
      // which would double-count the same operator.
      if (COMPLEXITY_STATEMENT_KINDS.has(kind) || COMPLEXITY_BINARY_TOKENS.has(kind)) {
        complexity += 1;
      }

      const childDepth = isDepthIncreasing(child) ? depth + 1 : depth;
      if (childDepth > maxDepth) maxDepth = childDepth;
      recurse(child, childDepth);
    });
  }

  // Walk the function's children (the body and signature). The fnNode itself is
  // the boundary we own; we descend into its children at depth 0.
  fnNode.forEachChild((child) => {
    const kind = child.getKind();
    if (COMPLEXITY_STATEMENT_KINDS.has(kind) || COMPLEXITY_BINARY_TOKENS.has(kind)) {
      complexity += 1;
    }
    const childDepth = isDepthIncreasing(child) ? 1 : 0;
    if (childDepth > maxDepth) maxDepth = childDepth;
    recurse(child, childDepth);
  });

  return { complexity, nestingDepth: maxDepth };
}

/**
 * Count distinct physical comment lines covered by `ranges`, deduped so
 * overlapping/consecutive line spans never double-count. Each range contributes
 * its [startLine, endLine] inclusive; we union the line sets (§6-A4).
 */
function countCommentLines(
  sourceFile: SourceFile,
  ranges: { start: number; end: number }[],
): number {
  const lines = new Set<number>();
  for (const r of ranges) {
    const startLine = sourceFile.getLineAndColumnAtPos(r.start).line;
    const endLine = sourceFile.getLineAndColumnAtPos(r.end).line;
    for (let l = startLine; l <= endLine; l++) lines.add(l);
  }
  return lines.size;
}

/**
 * A function's comment lines (§6-A4): its leading comment ranges (already
 * includes JSDoc) PLUS comment ranges physically inside its span — both leading
 * AND trailing. A trailing `// x` after code on the same line (e.g. on a branch)
 * is invisible to `getLeadingCommentRanges()`, so a fully-commented complex
 * function would otherwise report `commentLines: 0` and fire a false
 * `dense-undocumented`. We collect leading + trailing ranges from descendant
 * nodes whose position is inside the function span, fold them into the SAME
 * dedup-by-physical-line set, and count once per line.
 */
function functionCommentLines(fnNode: Node): number {
  const sf = fnNode.getSourceFile();
  const ranges: { start: number; end: number }[] = [];

  for (const r of fnNode.getLeadingCommentRanges()) {
    ranges.push({ start: r.getPos(), end: r.getEnd() });
  }

  const spanStart = fnNode.getStart(); // excludes leading trivia
  const spanEnd = fnNode.getEnd();
  // Inner comments attach as leading OR trailing trivia of descendant nodes.
  // Collect any whose position is inside the function body span.
  fnNode.forEachDescendant((d) => {
    for (const r of d.getLeadingCommentRanges()) {
      const pos = r.getPos();
      if (pos >= spanStart && pos < spanEnd) ranges.push({ start: pos, end: r.getEnd() });
    }
    for (const r of d.getTrailingCommentRanges()) {
      const pos = r.getPos();
      if (pos >= spanStart && pos < spanEnd) ranges.push({ start: pos, end: r.getEnd() });
    }
  });

  return countCommentLines(sf, ranges);
}

/** Compute all four metrics for one discovered function node (§7). */
export function computeFunctionMetrics(fnNode: Node): FunctionMetrics {
  const startLine = fnNode.getStartLineNumber();
  const endLine = fnNode.getEndLineNumber();
  const { complexity, nestingDepth } = walkBody(fnNode);
  return {
    loc: endLine - startLine + 1,
    commentLines: functionCommentLines(fnNode),
    nestingDepth,
    complexity,
  };
}

/**
 * ModuleNode.commentLines (§6-A4): ALL comment lines in the file. We scan every
 * node's leading AND trailing comment ranges across the whole file and dedup by
 * physical line, so a function's count (which also counts trailing comments) is
 * always a subset of this.
 */
export function moduleCommentLines(sourceFile: SourceFile): number {
  const ranges: { start: number; end: number }[] = [];
  for (const r of sourceFile.getLeadingCommentRanges()) {
    ranges.push({ start: r.getPos(), end: r.getEnd() });
  }
  sourceFile.forEachDescendant((d) => {
    for (const r of d.getLeadingCommentRanges()) {
      ranges.push({ start: r.getPos(), end: r.getEnd() });
    }
    for (const r of d.getTrailingCommentRanges()) {
      ranges.push({ start: r.getPos(), end: r.getEnd() });
    }
  });
  return countCommentLines(sourceFile, ranges);
}

/** Module LOC = total physical lines in the file. */
export function moduleLoc(sourceFile: SourceFile): number {
  return sourceFile.getEndLineNumber();
}

export { toRelative };
