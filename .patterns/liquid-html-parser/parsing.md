# Parsing a .liquid string into an AST

Entry into the library. You hand a raw `.liquid` file string to one function and
get back a `DocumentNode` whose `children` are the top-level nodes. There are two
entry functions with different opinions about HTML, plus an options object that
controls error tolerance.

## Approaches

### `toLiquidHtmlAST` — parse Liquid **and** HTML

**When to use:** The source is a `.liquid` template that contains HTML (the
normal case for a theme file). You want `HtmlElement`, attribute nodes, etc. in
the tree. This is the entry function a static checker over `.liquid` markup uses.

**Pattern:**

```typescript
import { toLiquidHtmlAST, LiquidHtmlNode, DocumentNode, NodeTypes } from '@shopify/liquid-html-parser';

const ast: DocumentNode = toLiquidHtmlAST(`
<body>
  {% for product in all_products %}
    <img src="{{ product | image_url }}">
  {% endfor %}
</body>
`);

ast.type;     // NodeTypes.Document ('Document')
ast.name;     // '#document'
ast.children; // LiquidHtmlNode[] — the top-level HTML + Liquid nodes
```

**Gotchas:**
- Default options are `{ allowUnclosedDocumentNode: false, mode: 'tolerant' }`.
  Because `allowUnclosedDocumentNode` is `false`, an unclosed HTML/Liquid block
  (e.g. `<div>` with no `</div>`) **throws** `LiquidHTMLASTParsingError`.
- The return type is `DocumentNode`, not `LiquidHtmlNode` — the root is always a
  Document; you read `.children` to get the union nodes.

### `toLiquidAST` — parse Liquid only, HTML stays text

**When to use:** You only care about the Liquid constructs and want HTML left as
opaque `TextNode`s (e.g. parsing a `{% liquid %}` body or a non-HTML asset).

**Pattern:**

```typescript
import { toLiquidAST, NodeTypes } from '@shopify/liquid-html-parser';

const ast = toLiquidAST(`{% assign x = 1 %}<div>not parsed as HTML</div>`);
// HTML is not structured into HtmlElement nodes; it remains TextNode content.
```

**Gotchas:**
- Its default options are `{ allowUnclosedDocumentNode: true, mode: 'tolerant' }`
  — the opposite of `toLiquidHtmlAST` on `allowUnclosedDocumentNode`. It does not
  throw on an unclosed document by default.
- It does **not** produce `HtmlElement` / attribute nodes. If you need to inspect
  HTML elements or attributes, use `toLiquidHtmlAST`.

## Options

Both functions take an optional second argument:

```typescript
interface ASTBuildOptions {
  /** Whether the parser should throw if the document node isn't closed */
  allowUnclosedDocumentNode: boolean;
  /**
   * 'strict'    — disable Liquid parsing base cases; throw if `markup` of a tag
   *               can't be parsed into a specific shape.
   * 'tolerant'  — default; unrecognized tag markup falls back to a string so the
   *               whole document still parses.
   * 'completion'— a parsing mode used for editor completion.
   */
  mode: 'strict' | 'tolerant' | 'completion';
}
```

In `'tolerant'` mode an unsupported or syntactically-off tag becomes a
`LiquidTagBaseCase` (its `markup` is a raw string) rather than throwing. In
`'strict'` mode that same tag throws. For a checker that must not crash on
unusual real-world themes, keep the default `'tolerant'`.

## Errors

Parse failures throw typed `SyntaxError` subclasses, both exported:

```typescript
import { LiquidHTMLASTParsingError, LiquidHTMLCSTParsingError } from '@shopify/liquid-html-parser';

try {
  toLiquidHtmlAST(brokenSource);
} catch (e) {
  if (e instanceof LiquidHTMLASTParsingError) {
    e.message;   // human-readable message
    e.loc;       // { start: {line, column}, end: {line, column} } | undefined
    e.unclosed;  // UnclosedNode | null — { type, name, blockStartPosition }
  }
}
```

- `LiquidHTMLCSTParsingError` — a syntax error caught at the grammar (stage-1)
  level; carries `loc` (line/column).
- `LiquidHTMLASTParsingError` — caught at the AST-build (stage-2) level, e.g. an
  unclosed block; carries `loc` and `unclosed`.

## Decision guide

| Situation | Approach | Why |
|---|---|---|
| `.liquid` template with HTML you must inspect | `toLiquidHtmlAST` | Only this builds `HtmlElement` + attribute nodes |
| Liquid-only source, HTML irrelevant | `toLiquidAST` | Leaves HTML as text; tolerant of unclosed doc by default |
| Must never crash on odd real-world input | either, `mode: 'tolerant'` | Unrecognized markup falls back to a string node |
| Want to reject malformed markup loudly | `mode: 'strict'` | Throws instead of falling back to base-case string |

## Rules

- The root is always a `DocumentNode` (`type: 'Document'`, `name: '#document'`);
  iterate `ast.children` to reach content nodes.
- `toLiquidHtmlAST` throws on an unclosed document by default; wrap it in
  `try/catch` if input may be malformed, or you will get an uncaught
  `LiquidHTMLASTParsingError`.

## Anti-patterns

| Don't do this | Why it breaks |
|---|---|
| Use `toLiquidAST` then look for `HtmlElement` nodes | It never builds them — HTML stays `TextNode`; only `toLiquidHtmlAST` structures HTML |
| Call `toLiquidHtmlAST` on possibly-truncated input with no `try/catch` | Default `allowUnclosedDocumentNode: false` throws `LiquidHTMLASTParsingError` |
| Treat the return value as a `LiquidHtmlNode` array | It is a single `DocumentNode`; the union nodes live under `.children` |

## See also

- [node-taxonomy.md](./node-taxonomy.md) — what the nodes in `.children` are
- [traversal.md](./traversal.md) — walking the returned tree
