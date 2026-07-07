# liquid-html-parser patterns

`@shopify/liquid-html-parser` turns the contents of a `.liquid` file into a single
Abstract Syntax Tree that contains **both** HTML nodes and Liquid nodes. These
patterns cover the read path: parsing a source string, identifying node types,
reading attribute values (including the case where a value is a Liquid
expression), walking the tree, and locating a node in the source for reporting.

Scope: the `@shopify/liquid-html-parser` package only — its stage-2 AST
(`toLiquidHtmlAST` / `toLiquidAST`), the `NodeTypes` taxonomy, the attribute node
kinds, the `walk` traversal helper, and `Position`. The stage-1 CST
(`toLiquidHtmlCST`) is an internal intermediate and is out of scope.

## Index

| Doc | Concern | Read when |
|---|---|---|
| [parsing.md](./parsing.md) | Turning a `.liquid` string into an AST | Choosing an entry function or handling parse errors |
| [node-taxonomy.md](./node-taxonomy.md) | The `NodeTypes` discriminated union | Branching on `node.type`; reading HTML/Liquid/text node fields |
| [attributes.md](./attributes.md) | HTML attribute node shapes + the dynamic-value case | Deciding "attribute present, value dynamic" vs "absent" vs "static string" |
| [traversal.md](./traversal.md) | Walking the AST and locating nodes in source | Visiting every node, recursing children, or reporting a finding's position |

## Shared conventions

- All examples use TypeScript / ESM imports from `@shopify/liquid-html-parser`.
- Every node carries `type`, `position` (`{ start, end }` byte offsets), and
  `source` (the full document string). `node.source.slice(node.position.start,
  node.position.end)` reconstructs a node's exact text.
- `NodeTypes` is a string enum — discriminate on `node.type`.
- The parser is permissive: HTML tag names and attribute names/values can be
  **arrays** mixing `TextNode` and `LiquidVariableOutput`, because Liquid can
  appear anywhere (`<tag-{{ name }}>`, `data-{{ k }}="{{ v }}"`).
