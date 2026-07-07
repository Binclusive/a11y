# Check definition

A check is a plain object with two parts: a `meta` block describing the check
(code, name, severity, target AST, docs, settings schema) and a `create(context)`
factory that returns a visitor object. The factory runs once per file, so its
closure is where you initialize per-file state. This doc covers the definition
shape; the visitor object it returns is in [visitor-api.md](./visitor-api.md).

## Approaches

### Liquid/HTML check (`LiquidCheckDefinition`)

**When to use:** The check inspects `.liquid` files (HTML elements, attributes, Liquid tags/filters) — the case for any structural-absence or attribute rule.

**Pattern:**

```typescript
import { Severity, SourceCodeType, LiquidCheckDefinition } from '../../types';

export const ImgWidthAndHeight: LiquidCheckDefinition = {
  meta: {
    code: 'ImgWidthAndHeight',          // unique shortname, no spaces; used in configs/IDEs
    name: 'Width and height attributes on image tags', // human-readable
    docs: {
      description:
        'This check is aimed at eliminating content layout shift in themes by enforcing the use of the width and height attributes on img tags.',
      recommended: true,
      url: 'https://shopify.dev/docs/storefronts/themes/tools/theme-check/checks/img-width-and-height',
    },
    type: SourceCodeType.LiquidHtml,    // which AST this check walks
    severity: Severity.ERROR,           // ERROR | WARNING | INFO
    schema: {},                         // no configurable settings
    targets: [],                        // see "targets" below
  },

  create(context) {
    // One create() call per file. Closure = per-file state.
    return {
      async HtmlVoidElement(node) {
        // visitor handler — see visitor-api.md
      },
    };
  },
};
```

**Gotchas:**
- `meta.type` must match the kind of `CheckDefinition` you typed it as. A `LiquidCheckDefinition` must set `type: SourceCodeType.LiquidHtml`.
- `code` must be unique. For renames, keep the old name working via `aliases: ['OldCode']` (parser-blocking-script uses `aliases: ['ParserBlockingScriptTag']`).
- `severity` is the *default*; a user's `.theme-check.yml` settings can override it per check.

### Check with configurable settings (`schema` + `context.settings`)

**When to use:** The check has a tunable parameter (a threshold, a list of allowed names) the user sets in their config.

**Pattern:**

```typescript
import { LiquidCheckDefinition, SchemaProp, Severity, SourceCodeType } from '../../types';

const schema = {
  thresholdInBytes: SchemaProp.number(100000), // default value baked into the prop
};

export const AssetSizeCSS: LiquidCheckDefinition<typeof schema> = {
  meta: {
    code: 'AssetSizeCSS',
    name: 'Prevent Large CSS bundles',
    docs: { description: '...', url: '...', recommended: false },
    type: SourceCodeType.LiquidHtml,
    severity: Severity.ERROR,
    schema,                              // attach the schema object
    targets: [],
  },

  create(context) {
    const thresholdInBytes = context.settings.thresholdInBytes; // typed from the schema
    return {
      async HtmlVoidElement(node) {
        // ...use thresholdInBytes...
      },
    };
  },
};
```

`SchemaProp` factory methods (from `types/schema-prop-factory`):

```typescript
SchemaProp.string(defaultValue?)        // string setting
SchemaProp.number(defaultValue?)        // number setting
SchemaProp.boolean(defaultValue?)       // boolean setting
SchemaProp.object({ key: SchemaProp.string() }, defaultValue?) // nested object
SchemaProp.array(SchemaProp.string(), ['a','b'])               // array of items
SchemaProp.number().optional()          // makes the setting T | undefined
```

`context.settings` is `{ [K in keyof schema]: value }`, with each value resolved from the user's config or the prop's `defaultValue()`.

**Gotchas:**
- Pass `typeof schema` as the generic (`LiquidCheckDefinition<typeof schema>`) so `context.settings` is typed.
- A setting's value is `userConfig[key] ?? schemaProp.defaultValue()`. A `SchemaProp.number()` with no default yields `undefined` at runtime.

## The `meta` block fields

| Field | Required | Meaning |
|---|---|---|
| `code` | yes | Unique shortname (no spaces). Used in YAML config + IDE. |
| `name` | yes | Human-readable title. |
| `severity` | yes | `Severity.ERROR` (0), `Severity.WARNING` (1), or `Severity.INFO` (2). |
| `type` | yes | `SourceCodeType.LiquidHtml` or `SourceCodeType.JSON`. |
| `docs` | yes | `{ description: string; recommended?: boolean; url?: string }`. |
| `schema` | yes | Settings schema object (`{}` for none). |
| `aliases` | no | Alternative `code` names kept for backwards compatibility. |
| `targets` | no | Which YAML configs enable the check (see below). |
| `deprecated` / `replacedBy` | no | Flags for retired checks. |

**`targets`:** When empty/omitted, the check is `enabled: true` in `all.yml`. When values are given (`ConfigTarget.Recommended`, `ConfigTarget.ThemeAppExtension`, `ConfigTarget.All`), the check is enabled only in the matching YAML config.

## Decision guide

| Situation | Approach | Why |
|---|---|---|
| Inspecting `.liquid` HTML/attributes | `LiquidCheckDefinition`, `type: SourceCodeType.LiquidHtml` | The visitor receives Liquid/HTML AST nodes |
| Inspecting `.json` template/section files | `JSONCheckDefinition`, `type: SourceCodeType.JSON` | The visitor receives JSON AST nodes |
| Check needs a user-tunable parameter | Add `schema` with `SchemaProp.*`, read `context.settings` | Validated, documented, IDE-supported settings |
| Renaming an existing check's code | Keep old name in `aliases` | Existing user configs keep working |

## Rules

- A check is a plain exported `const` object — never instantiate a class.
- `create(context)` is called once per file; put per-file accumulators in its closure, not module scope, or state leaks across files.
- The returned object's keys are AST node-type strings (or lifecycle method names) — see [visitor-api.md](./visitor-api.md).
- To report a problem, call `context.report(...)` — never push to a shared array yourself. See [reporting-offenses.md](./reporting-offenses.md).

## Anti-patterns

| Don't do this | Why it breaks |
|---|---|
| Module-level `const seen = new Set()` shared across `create` calls | State bleeds between files; each file must start fresh |
| `type: SourceCodeType.JSON` on a `LiquidCheckDefinition` | Type mismatch; the runner routes the check to the wrong AST and visitor |
| Reading `context.settings.foo` without `foo` in `schema` | Untyped/undefined; the value is never populated |

## See also

- [visitor-api.md](./visitor-api.md) — what `create()` returns and how nodes are visited
- [reporting-offenses.md](./reporting-offenses.md) — `context.report` and the offense shape
- [html-attribute-checks.md](./html-attribute-checks.md) — complete worked examples of attribute checks
