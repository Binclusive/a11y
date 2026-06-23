# theme-check-common patterns

How to author static checks over the Liquid/HTML AST: the `CheckDefinition`
shape, the visitor node-callback API, how a check reports an offense, and the
existing HTML-attribute/structural-absence checks that serve as prior art. The
AST a check walks is produced by `@shopify/liquid-html-parser` (a separate
concern, not documented here — only the node-type keys and node fields a check
reads are covered).

Scope: only the `theme-check-common` package — the check-authoring surface
(`CheckDefinition`, `Context`, the visitor, `SchemaProp`, the corrector). The
language server, CLI wiring, JSON-schema validation, and the parser internals
are out of scope.

## Index

| Doc | Concern | Read when |
|---|---|---|
| [check-definition.md](./check-definition.md) | The `LiquidCheckDefinition` object: `meta` block + `create(context)` factory + `schema`/settings | Authoring a new check from scratch and getting the `meta`/`create` shape right |
| [visitor-api.md](./visitor-api.md) | Registering node-type handlers, enter/exit, `onCodePathStart`/`onCodePathEnd`, `ancestors`, traversal order | Hooking specific AST nodes (HtmlVoidElement, LiquidTag…) and deciding enter vs exit vs end-of-file |
| [reporting-offenses.md](./reporting-offenses.md) | `context.report(problem)` — message, `startIndex`/`endIndex`, severity, `fix`/`suggest` correctors | Emitting a finding with the right location and (optionally) an autofix |
| [html-attribute-checks.md](./html-attribute-checks.md) | Existing HTML-attribute / structural-absence checks (img width+height, parser-blocking-script, deprecate-bgsizes) + the attribute helpers | Writing a "missing/required/forbidden attribute on element X" rule |

## Shared conventions

- All examples are TypeScript / ESM. Checks are plain objects exported as `const`.
- A check's `meta.type` is one of `SourceCodeType.LiquidHtml` or `SourceCodeType.JSON`; the docs here focus on `LiquidHtml`.
- The API is intentionally ESLint-shaped: `meta` + `create(context)` returning a visitor object keyed by node type, with `node.type` strings as the handler names and `${type}:exit` for exit handlers.
- Positions in a `Problem` are 0-indexed character offsets into the file source (`startIndex` included, `endIndex` excluded); the runner converts them to line/character `Position` objects on the resulting `Offense`.
