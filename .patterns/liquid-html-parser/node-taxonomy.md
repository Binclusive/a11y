# Node taxonomy — the LiquidHtmlNode discriminated union

Every node in the tree is a member of the `LiquidHtmlNode` union, discriminated
by a string `type` field whose values come from the `NodeTypes` enum. This doc
maps the type tags to their node shapes so you can branch on `node.type` and read
the right fields without guessing.

## The discriminator

```typescript
import { NodeTypes } from '@shopify/liquid-html-parser';

switch (node.type) {
  case NodeTypes.HtmlElement: /* ... */ break;
  case NodeTypes.LiquidVariableOutput: /* ... */ break;
  case NodeTypes.TextNode: /* ... */ break;
  // ...
}
```

`NodeTypes` is a string enum (`NodeTypes.HtmlElement === 'HtmlElement'`), so a
raw `node.type === 'HtmlElement'` comparison also works. Two convenience arrays
group the common ones:

```typescript
import { HtmlNodeTypes, LiquidNodeTypes } from '@shopify/liquid-html-parser';

// HtmlNodeTypes  = [HtmlElement, HtmlDanglingMarkerClose, HtmlRawNode, HtmlVoidElement, HtmlSelfClosingElement]
// LiquidNodeTypes = [LiquidTag, LiquidVariableOutput, LiquidBranch, LiquidRawTag]
```

## Node groups

### HTML element nodes

All HTML element nodes share `HtmlNodeBase`: `attributes: AttributeNode[]` and
`blockStartPosition: Position`.

| `type` | Shape highlights |
|---|---|
| `HtmlElement` | Normal `<div>...</div>`. `name: (TextNode \| LiquidVariableOutput)[]` (compound — see below), `children: LiquidHtmlNode[]`, `blockEndPosition: Position`. |
| `HtmlVoidElement` | `<img>`, `<br>` — cannot have children. `name: string` (plain string, **not** an array — comes from a fixed list). |
| `HtmlSelfClosingElement` | `<x />`. `name: (TextNode \| LiquidVariableOutput)[]`. |
| `HtmlRawNode` | `<script>`, `<style>` — body not parsed as HTML. `name: string`, `body: RawMarkup`, `blockEndPosition: Position`. |
| `HtmlDanglingMarkerClose` | A `</tag>` with no matching open (e.g. inside an `{% if %}`). `name: (TextNode \| LiquidVariableOutput)[]`, `blockStartPosition: Position`. |
| `HtmlComment` | `<!-- ... -->`. `body: string`. |
| `HtmlDoctype` | `<!doctype html>`. `legacyDoctypeString: string \| null`. |

**Tag names are usually arrays.** For `HtmlElement`, `HtmlSelfClosingElement`,
and `HtmlDanglingMarkerClose`, `name` is `(TextNode | LiquidVariableOutput)[]`,
because a tag name can be compound and contain Liquid:

```liquid
<tag-{{ name }}>   {%- name = [TextNode('tag-'), LiquidVariableOutput] -%}
```

`HtmlVoidElement.name` and `HtmlRawNode.name` are plain `string`. To get a
display string regardless of shape, see `getName` in
[traversal.md](./traversal.md).

### Liquid nodes

| `type` | Represents | Shape highlights |
|---|---|---|
| `LiquidVariableOutput` | `{{ ... }}` output | `markup: string \| LiquidVariable` (raw string in base case, parsed `LiquidVariable` otherwise), `whitespaceStart`/`whitespaceEnd: '-' \| ''`. Position **includes** the `{{ }}` braces. |
| `LiquidTag` | `{% tag markup %}` | `name` (e.g. `'if'`, `'for'`), `markup`, optional `children: LiquidHtmlNode[]`, `blockStartPosition`, optional `blockEndPosition`. Strictly-typed tags (`if`, `for`, `assign`, …) have structured `markup`; unknown tags fall back to `LiquidTagBaseCase` with a string `markup`. |
| `LiquidBranch` | An `{% else %}` / `{% elsif %}` / `{% when %}` branch inside a branched tag | `name` (`null` for the implicit first branch), `markup`, `children`. |
| `LiquidRawTag` | `{% raw %}`, `{% style %}`, `{% javascript %}` | `name`, `markup: string`, `body: RawMarkup`, `blockStartPosition`, `blockEndPosition`. Body is **not** parsed. |

`LiquidVariableOutput.markup` is the load-bearing field. In the base case
(`{{ !-asd }}`) `markup` is the raw **string** `'!-asd'`. For a parseable drop it
is a `LiquidVariable` object:

```typescript
// {{ product | image_url }}
node.type;                        // 'LiquidVariableOutput'
node.markup.type;                 // 'LiquidVariable'
node.markup.rawSource;            // 'product | image_url'
node.markup.expression.type;      // 'VariableLookup'
node.markup.expression.name;      // 'product'
node.markup.filters;              // LiquidFilter[]  → [{ name: 'image_url', args: [] }]
```

So always check `typeof node.markup === 'string'` before reaching into
`.expression` / `.rawSource`.

### Text node

| `type` | Shape |
|---|---|
| `TextNode` | `{ type: 'TextNode', value: string, position, source }` — generic literal text. |

### Container / root

| `type` | Shape |
|---|---|
| `Document` | Root. `name: '#document'`, `children: LiquidHtmlNode[]`. |
| `YAMLFrontmatter` | `body: string` — leading `---` frontmatter block. |

(The enum also contains expression-level types — `LiquidVariable`,
`VariableLookup`, `String`, `Number`, `LiquidFilter`, `NamedArgument`, etc. —
and `LiquidDoc*` nodes for `{% doc %}` comments. You reach these by descending
into a node's `markup`/`expression`; they are not direct `children`.)

## Rules

- Discriminate on `node.type` against `NodeTypes` values before reading any
  type-specific field.
- `name` is a plain `string` on `HtmlVoidElement`, `HtmlRawNode`, `LiquidTag`,
  `LiquidRawTag`, `LiquidBranch`; it is a `(TextNode | LiquidVariableOutput)[]`
  array on `HtmlElement`, `HtmlSelfClosingElement`, `HtmlDanglingMarkerClose`.
  Never assume one shape.
- `LiquidVariableOutput.markup` is `string | LiquidVariable`. Guard with
  `typeof === 'string'` before accessing `.expression`/`.rawSource`/`.filters`.

## Anti-patterns

| Don't do this | Why it breaks |
|---|---|
| `htmlElement.name.toLowerCase()` | `HtmlElement.name` is an array, not a string — call fails. Use `getName(node)`. |
| `output.markup.expression.name` on any `{{ }}` | `markup` can be a raw string (base case); `.expression` is `undefined`, throws. |
| Looking for `<img>` children | `HtmlVoidElement` has no `children` — void elements can't contain nodes. |
| Parsing `<script>` body as HTML | It is an `HtmlRawNode`; the body is a `RawMarkup` string, not structured nodes. |

## See also

- [attributes.md](./attributes.md) — the `attributes` array shared by HTML element nodes
- [traversal.md](./traversal.md) — `getName` for normalizing array vs string names; `walk`
