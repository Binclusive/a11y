# Reporting offenses

A check signals a finding by calling `context.report(problem)`. The `Problem`
carries the human message and a character range (`startIndex`/`endIndex`) into
the file. The runner turns each reported `Problem` into an `Offense` — attaching
the check's `code`, the file `uri`, the severity, and converting the indices
into line/character `Position` objects. You never construct an `Offense` or push
to an array yourself; you only call `context.report`.

## Approaches

### Plain offense (message + location)

**When to use:** Every check. The minimal report — a message and the source range to highlight.

**Pattern:**

```typescript
context.report({
  message: `Missing width and height attributes on img tag`,
  startIndex: node.position.start, // 0-indexed, included
  endIndex: node.position.end,     // 0-indexed, excluded
});
```

`message` is shown to the user. `startIndex`/`endIndex` are character offsets into the file `source`; the highlighted span is `source.slice(startIndex, endIndex)`.

**Gotchas:**
- `endIndex` is *excluded*. To highlight a whole node, use `node.position.start` … `node.position.end` (the parser's `Position` already follows the included/excluded convention).
- Point at the most specific node available. The whole element (`node.position`), a specific attribute (`attr.position` or `attr.attributePosition`), or a filter range — whatever the user should look at.

### Offense with an autofix (`fix`)

**When to use:** There is exactly one safe, unambiguous correction.

**Pattern:**

```typescript
context.report({
  message: `Remove the unused variable '${variable}'`,
  startIndex: node.position.start,
  endIndex: node.position.end,
  fix: (corrector) => {
    corrector.remove(node.position.start, node.position.end);
  },
});
```

The `fix` receives a `Corrector`. For Liquid/HTML checks it's a `StringCorrector`:

```typescript
corrector.insert(index, text);          // insert before index
corrector.replace(start, end, text);    // replace [start, end) with text
corrector.remove(start, end);           // delete [start, end)
```

**Gotchas:**
- Reserve `fix` for *safe* changes only. The corrector collects `FixDescription`s; the fix applicator rejects overlapping ranges.
- All fix indices are relative to the *original, unmodified* source. Don't pre-adjust for other fixes — the applicator handles index drift.

### Offense with suggestions (`suggest`)

**When to use:** The fix is unsafe, or there are multiple valid corrections and the user must choose (e.g. add `defer` *or* `async`).

**Pattern:**

```typescript
context.report({
  message: 'Avoid parser blocking scripts by adding `defer` or `async` on this tag',
  startIndex: node.position.start,
  endIndex: node.position.end,
  suggest: [
    { message: 'Add defer', fix: (corrector) => corrector.insert(/* … */, ' defer') },
    { message: 'Add async', fix: (corrector) => corrector.insert(/* … */, ' async') },
  ],
});
```

Each `Suggestion` is `{ message, fix }`. A suggestion's `fix` uses the same corrector API as an autofix, but is offered to the editor rather than applied automatically.

**Gotchas:**
- `suggest` may be `undefined` (compute it conditionally and pass `undefined` when not applicable — parser-blocking-script does exactly this based on the surrounding nodes).
- Use `suggest` (not `fix`) whenever the correct fix is ambiguous; `fix` implies "apply this without asking".

## The Problem → Offense pipeline

You report a `Problem`:

```typescript
type Problem = {
  message: string;
  startIndex: number;  // 0-indexed, included
  endIndex: number;    // 0-indexed, excluded
  fix?: Fixer;
  suggest?: Suggestion[];
};
```

The runner's `context.report` produces an `Offense`:

```typescript
{
  type: check.meta.type,
  check: check.meta.code,                          // your meta.code
  message: problem.message,
  uri: file.uri,
  severity: checkSettings?.severity ?? check.meta.severity, // user override wins
  start: getPosition(file.source, problem.startIndex),      // { index, line, character }
  end: getPosition(file.source, problem.endIndex),
  fix: problem.fix,
  suggest: problem.suggest,
}
```

`getPosition` maps a character index to a `Position`: `{ index, line (1-indexed), character (0-indexed) }`. Severity comes from the user's per-check config if set, otherwise the check's `meta.severity`.

## Severity

`Severity` is an enum: `ERROR = 0`, `WARNING = 1`, `INFO = 2`. It is set on `meta.severity` (the default) and can be overridden per check via user config. It does not appear in the `report` call — it's resolved by the runner.

## Decision guide

| Situation | Field | Why |
|---|---|---|
| Just flag the problem | (no `fix`/`suggest`) | Most checks only need a message + range |
| One safe, unambiguous correction | `fix` | Editors apply it automatically |
| Unsafe fix, or multiple valid choices | `suggest` | User picks; nothing applied automatically |
| Highlight a sub-part (one attribute) | `startIndex`/`endIndex` from that node's position | Precise, actionable location |

## Rules

- Always call `context.report` — never build an `Offense` or mutate an offense array directly.
- `startIndex` is included, `endIndex` excluded; both are 0-indexed character offsets into `file.source`.
- Fix/suggestion corrector indices are relative to the original source; never pre-compensate for other edits.
- Set severity on `meta.severity`, not in the `report` call.

## Anti-patterns

| Don't do this | Why it breaks |
|---|---|
| Returning the finding from the handler | The visitor ignores return values for reporting; use `context.report` |
| Using `fix` for an ambiguous correction (e.g. defer vs async) | Auto-applies an arbitrary choice; use `suggest` with both options |
| Adjusting fix indices for prior fixes in the same run | The fix applicator already resolves index drift; double-adjusting corrupts the output |
| Off-by-one ranges treating `endIndex` as inclusive | `endIndex` is excluded; the highlighted slice would be wrong |

## See also

- [visitor-api.md](./visitor-api.md) — where `context.report` is called from
- [check-definition.md](./check-definition.md) — where `meta.severity` is set
- [html-attribute-checks.md](./html-attribute-checks.md) — report calls in real missing-attribute checks
