# SARIF patterns

How to emit and reason about SARIF 2.1.0 **results** — the finding-interchange
format GitHub code scanning, IDE SARIF viewers, and coding agents consume. These
docs are grounded in the OASIS SARIF 2.1.0 specification and the
`microsoft/sarif-sdk` schema + sample logs. They exist to stop the most common
mistake in SARIF authoring: treating `result.fixes[]` as a place for advisory
prose when it is structurally a set of concrete source edits.

Scope: the **result-level** surfaces — the `result` object and its
`fixes[]`/`relatedLocations[]` arrays — plus how consumers turn a result into a
fix. The run/tool/driver envelope, taxonomies, notifications, invocations, and
external property files are out of scope.

## Index

| Doc | Concern | Read when |
|---|---|---|
| [result-object.md](./result-object.md) | The `result` shape: `message`, `ruleId`, `level`/`kind`, `locations`, fingerprints, and which properties carry weight | Emitting or reading a single finding and getting the required/optional fields right |
| [fixes.md](./fixes.md) | `fix` → `artifactChanges[]` → `replacements[]` → `deletedRegion`/`insertedContent`; why a fix is never prose-only | Proposing a repair — deciding concrete replacement vs insertion vs deletion, or realizing you should not emit `fixes[]` at all |
| [related-locations.md](./related-locations.md) | `relatedLocations[]`, the `location` object, `id`, message embedded links, typed `relationships` | A finding references a second spot ("declared here", data-flow source) |
| [autofix-consumption.md](./autofix-consumption.md) | What GitHub Copilot Autofix + coding agents actually read; auto-fixable vs advisory | Deciding where to invest to make findings auto-fixable (spoiler: usually not `fixes[]`) |

## Shared conventions

- Examples are JSON SARIF fragments (a `result` object or a sub-object of one),
  as they appear inside `runs[].results[]`.
- Requiredness is quoted from the SARIF 2.1.0 JSON schema (`required` arrays) and
  the spec's SHALL/SHOULD/MAY prose; section numbers (e.g. §3.55) reference the
  OASIS spec.
- Region coordinates are either text (`startLine`/`startColumn`/`endColumn` or
  `charOffset`/`charLength`) or binary (`byteOffset`/`byteLength`) — never mixed.
