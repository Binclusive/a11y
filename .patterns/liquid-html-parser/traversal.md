# Traversing the AST and locating nodes in source

Once you have a `DocumentNode`, you need to visit every node (to find every
`<img>`, every attribute, etc.) and, for each finding, point back at an exact
location in the source. The library ships a `walk` helper and a `getName`
normalizer, and every node carries position info.

## Approaches

### `walk` — visit every node with its parent

**When to use:** You want to run a check against every node in the tree. This is
the default traversal for a checker.

**Pattern:**

```typescript
import { toLiquidHtmlAST, walk, NodeTypes, LiquidHtmlNode } from '@shopify/liquid-html-parser';

const ast = toLiquidHtmlAST(source);

walk(ast, (node: LiquidHtmlNode, parent: LiquidHtmlNode | undefined) => {
  if (node.type === NodeTypes.HtmlVoidElement && node.name === 'img') {
    const hasAlt = node.attributes.some((a) => /* see getName below */ true);
    // report a finding using node.position …
  }
});
```

`walk(ast, fn, parentNode?)` recurses depth-first. For each node it visits every
own property, descends into arrays (filtering to real nodes via
`isLiquidHtmlNode`) and into nested node values, then calls `fn(node, parent)`
**after** descending (post-order; the callback fires bottom-up). The parent is
passed as the second argument; it is `undefined` for the root.

**Gotchas:**
- The callback fires post-order (children before parent). If you need to know a
  result about children when visiting a parent, compute it from `node.children`
  inside the callback rather than relying on visit order.
- `walk` skips the cyclic convenience links (`parentNode`, `prev`, `next`,
  `firstChild`, `lastChild`) via the `nonTraversableProperties` set, so it does
  not infinite-loop — but those links are only present if some other pass added
  them; a fresh AST from `toLiquidHtmlAST` does not populate them.

### Manual recursion over `children`

**When to use:** You need control `walk` does not give — e.g. pre-order visiting,
early exit, or threading accumulated state down the tree.

**Pattern:**

```typescript
import { NodeTypes, LiquidHtmlNode } from '@shopify/liquid-html-parser';

function visit(node: LiquidHtmlNode, depth: number) {
  // pre-order work here …

  // children live on different fields depending on node type:
  const kids: LiquidHtmlNode[] =
    'children' in node && Array.isArray((node as any).children) ? (node as any).children : [];
  for (const child of kids) visit(child, depth + 1);
}

visit(ast, 0);
```

**Gotchas:**
- Child nodes are not all under `children`. HTML attribute values live in an
  attribute's `value` array, attribute lists in `attributes`, compound names in
  `name` arrays, and Liquid expressions under `markup`/`expression`. Plain
  `children` recursion misses attributes and names — `walk` covers all of them
  because it visits every property. Prefer `walk` unless you specifically need
  pre-order or early exit.

### `getName` — normalize a node's name to a string

**When to use:** A node's `name` may be a plain string or a
`(TextNode | LiquidVariableOutput)[]` array (see
[node-taxonomy.md](./node-taxonomy.md)). `getName` collapses either form to one
display string.

**Pattern:**

```typescript
import { getName } from '@shopify/liquid-html-parser';

getName(htmlElementNode);   // '<{{ type }}>' → 'tag-{{type}}' style string
getName(voidImgNode);       // 'img'
getName(attrNode);          // 'alt'  (resolves a compound attribute name too)
```

For an element/attribute whose name array contains a `LiquidVariableOutput`,
`getName` renders that piece as `{{ ... }}` (using the drop's trimmed markup /
`rawSource`) and concatenates the parts. It returns `null` when there is no name.

**Gotchas:**
- `getName` returns `string | null`. A `null` means an unnamed node (e.g. an
  implicit Liquid branch); guard before using the result as a tag name.

## Source position — reporting a finding's location

Every node carries position info inherited from `ASTNode`:

```typescript
interface Position {
  start: number; // 0-indexed byte offset, inclusive
  end: number;   // 0-indexed byte offset, exclusive
}

interface ASTNode<T> {
  type: T;
  position: Position; // the range the node covers
  source: string;     // the FULL document string
}

// Reconstruct a node's exact text:
const text = node.source.slice(node.position.start, node.position.end);
```

Additional ranges on specific node kinds:

| Field | On | Covers |
|---|---|---|
| `blockStartPosition` | HTML element nodes, `LiquidTag`, `LiquidRawTag` | the opening tag |
| `blockEndPosition` | `HtmlElement`, `HtmlRawNode`, `LiquidRawTag`, branched `LiquidTag` | the closing tag |
| `attributePosition` | `Attr*` nodes | the attribute value range, excluding quotes |

To convert an offset to line/column for a human-readable report, the offsets are
plain indices into `node.source`; the library's own errors use the `line-column`
package for this, and `LiquidHTMLASTParsingError.loc` already exposes
`{ line, column }` for parse failures (see [parsing.md](./parsing.md)).

## Decision guide

| Situation | Approach | Why |
|---|---|---|
| Run a check on every node | `walk` | Visits attributes, names, and children — not just `children` |
| Need pre-order or early exit | manual recursion | `walk` is post-order and visits the whole tree |
| Display a tag/attribute name | `getName` | Handles both string and array name forms |
| Report where a finding is | `node.position` + `node.source` | Offsets index directly into the source string |

## Rules

- Use `walk` for full-tree checks; plain `children` recursion silently skips
  attributes, names, and Liquid expression subtrees.
- `node.position.end` is **exclusive**; `source.slice(start, end)` is the exact
  node text.
- Normalize names with `getName` before string-comparing a tag/attribute name —
  never `.toLowerCase()` an array-typed `name`.

## Anti-patterns

| Don't do this | Why it breaks |
|---|---|
| Recurse only `node.children` to find attributes | Attributes live in `node.attributes`/`value`, not `children` — they are never visited |
| `getName(node).toLowerCase()` unguarded | `getName` can return `null`; calling a method on it throws |
| `source.slice(start, end + 1)` | `end` is already exclusive; the `+1` over-reads by one character |

## See also

- [node-taxonomy.md](./node-taxonomy.md) — which `name`/`children` fields each node type has
- [attributes.md](./attributes.md) — descending into `attributes` and attribute `value` arrays
- [parsing.md](./parsing.md) — `LiquidHTMLASTParsingError.loc` for line/column on parse errors
