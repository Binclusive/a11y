# Visitor API

`create(context)` returns a visitor object: an object whose keys are AST
node-type strings and whose values are async handlers. The runner walks the
file's AST and calls your handler each time it encounters a node of that type.
This is the ESLint-style node-callback model — you do not write the traversal,
you register interest in node types.

## Approaches

### Enter handler (per-node, going down the tree)

**When to use:** You can decide on a finding from a single node and its ancestors — the default for attribute/element checks.

**Pattern:**

```typescript
create(context) {
  return {
    // Key = the node's `type` string. Handler runs once per matching node,
    // in document order, while descending the tree.
    async HtmlVoidElement(node, ancestors) {
      if (node.name !== 'img') return;
      // node is the matched AST node; ancestors is the lineage above it
    },
  };
}
```

The handler signature is `(node, ancestors) => Promise<void>`:
- `node` — the matched node, narrowed to that node type.
- `ancestors` — array of nodes from the root down to (but **not** including) the current node. `ancestors.at(-1)` is the direct parent.

**Gotchas:**
- The key must exactly match a node-type string from the parser's `NodeTypes` enum (see table below). A typo'd key is silently never called.
- Handlers are `async`; the runner `await`s each one. Always early-`return` for nodes you don't care about.

### Exit handler (`${NodeType}:exit`, in reverse order)

**When to use:** You need to have already seen the node's children before acting on it.

**Pattern:**

```typescript
create(context) {
  return {
    async HtmlElement(node, ancestors) {
      // entering: before children are visited
    },
    'HtmlElement:exit': async (node, ancestors) => {
      // exiting: after all descendants have been visited
    },
  };
}
```

**Gotchas:**
- The exit key is the literal string `` `${NodeType}:exit` `` and must be quoted as an object key.
- Same `(node, ancestors)` signature as the enter handler.

### Whole-file accumulation (`onCodePathStart` / `onCodePathEnd`)

**When to use:** The finding depends on the *whole file* — "assigned but never used", "unbalanced open/close tags". Collect during traversal, decide at the end.

**Pattern:**

```typescript
create(context) {
  const assignedVariables = new Map<string, Node>(); // per-file state in the closure
  const usedVariables = new Set<string>();

  return {
    async LiquidTag(node) {
      // ...record assignments into assignedVariables...
    },
    async VariableLookup(node) {
      // ...record usages into usedVariables...
    },
    async onCodePathEnd() {
      // Runs once, after the entire file is traversed.
      for (const [variable, node] of assignedVariables.entries()) {
        if (!usedVariables.has(variable)) {
          context.report({
            message: `The variable '${variable}' is assigned but not used`,
            startIndex: node.position.start,
            endIndex: node.position.end,
          });
        }
      }
    },
  };
}
```

Lifecycle methods:
- `onCodePathStart(file)` — runs *before* traversal; `file.ast` may be an `Error` (unparseable file).
- `onCodePathEnd(file)` — runs *after* traversal; `file.ast` is guaranteed to be a real AST node (skipped if the file failed to parse).

**Gotchas:**
- `onCodePathStart` fires even when the file is unparseable; `onCodePathEnd` does not. Don't assume a `start` is always paired with an `end`.
- Because traversal is async, accumulated nodes are not guaranteed to be in source order — sort by `position.start` if order matters (the unclosed-element check sorts before balancing).

## Traversal model

The runner walks the AST with an explicit stack (depth-first, document order for enter handlers). For each node it pops: it calls the enter handler `check[node.type]`, pushes the node's child nodes (array children pushed last-to-first so they pop in order), then calls the exit handler `check[`${node.type}:exit`]`. Any object value with a string `type` field is treated as a child node; the parser marks a few fields (`nonTraversableProperties`) as non-traversable and they are skipped.

A missing handler is a no-op — checks only implement the node types they care about. (Internally, absent methods resolve to a no-op via a Proxy, so you never need to define handlers you don't use.)

## Node-type keys (Liquid/HTML)

The handler key is the node's `type` string. The HTML/attribute-relevant ones:

| Key | Node | Notes |
|---|---|---|
| `HtmlElement` | `<div>…</div>` paired element | Has `children`, `attributes`, `blockEndPosition` |
| `HtmlVoidElement` | `<img>`, `<input>`, `<link>` | Void elements; has `attributes`, no children |
| `HtmlSelfClosingElement` | `<x />` | Self-closing |
| `HtmlRawNode` | `<script>`, `<style>` | Raw-content elements; has `attributes` |
| `HtmlComment` | `<!-- … -->` | |
| `HtmlDoctype` | `<!doctype …>` | |
| `HtmlDanglingMarkerClose` | `</x>` without an open | Used by unbalanced-tag checks |
| `AttrSingleQuoted` / `AttrDoubleQuoted` / `AttrUnquoted` | `x='…'` / `x="…"` / `x=…` | The three *valued* attribute node types |
| `AttrEmpty` | bare attribute, e.g. `disabled` | Valueless attribute |
| `TextNode` | raw text | Attribute names/values are arrays of these (interleaved with Liquid) |
| `LiquidTag` | `{% … %}` | `node.name` is the tag name (`assign`, `if`, …) |
| `LiquidFilter` | a filter in `{{ x \| filter }}` | `node.name` is the filter name |
| `LiquidVariableOutput` | `{{ … }}` | |
| `VariableLookup` | a variable reference | `node.name` |

(The full set lives in the parser's `NodeTypes` enum; these are the ones HTML/attribute checks use.)

## Decision guide

| Situation | Approach | Why |
|---|---|---|
| Decide from one node + its ancestors | Enter handler (`HtmlVoidElement(node, ancestors)`) | Simplest; runs in document order |
| Must see children first | Exit handler (`'HtmlElement:exit'`) | Fires after descendants |
| Decide from the whole file | Accumulate in closure, decide in `onCodePathEnd` | End-of-file is the only point with full information |
| Need parent/grandparent | Read `ancestors.at(-1)`, `ancestors.at(-2)` | `ancestors` excludes the current node |

## Rules

- Handler keys are exact `NodeTypes` strings; `:exit` suffix for exit handlers.
- The handler receives `(node, ancestors)` where `ancestors` excludes the current node.
- Per-file state lives in the `create` closure, never module scope.
- Don't rely on `onCodePathEnd`-collected nodes being in source order — sort by `position.start` when order matters.

## Anti-patterns

| Don't do this | Why it breaks |
|---|---|
| `htmlVoidElement(node)` (wrong casing) | Key must match `NodeTypes` exactly; handler never fires |
| `HtmlElementExit(node)` instead of `'HtmlElement:exit'` | Exit handlers use the quoted `:exit` suffix |
| Reading `ancestors[ancestors.length - 1]` as "current node" | `ancestors` is the lineage *above* the node; the last entry is the parent |
| Assuming an `onCodePathStart` always has a matching `onCodePathEnd` | `End` is skipped on unparseable files |

## See also

- [check-definition.md](./check-definition.md) — the `meta` + `create` shell around this visitor object
- [reporting-offenses.md](./reporting-offenses.md) — what to call inside a handler when you find a problem
- [html-attribute-checks.md](./html-attribute-checks.md) — full attribute-check examples using these handlers
