# The fixes array

`result.fixes[]` is where a tool proposes how to repair a finding. A `fix`
object is **a concrete set of edits to source bytes** — not an advisory note.
This is the single most misused corner of SARIF: the spec's own words are "A fix
specifies a set of artifacts to modify. For each artifact, it specifies a set of
bytes to remove, and provides a set of new bytes to replace them" (§3.55.1). If
you cannot name the exact bytes to change, you cannot emit a `fix`. This doc
exists so an agent never emits a schema-invalid prose-only fix, and knows when
`fixes[]` is the wrong surface entirely.

## The nesting, top to bottom

```
result
└── fixes[]                       (array of fix)
    └── fix
        ├── description           message object   — SHOULD, prose for viewers
        └── artifactChanges[]     REQUIRED, ≥1      — the actual edits
            └── artifactChange
                ├── artifactLocation  REQUIRED       — which file
                └── replacements[]    REQUIRED, ≥1   — the edits in that file
                    └── replacement
                        ├── deletedRegion    REQUIRED  — the bytes/chars to remove
                        └── insertedContent  optional  — what to put in their place
```

Required arrays, verbatim from the JSON schema:
`fix.required = ["artifactChanges"]`,
`artifactChange.required = ["artifactLocation", "replacements"]`,
`replacement.required = ["deletedRegion"]`.

## The one rule that governs everything

**A `fix` with only a `description` and no `artifactChanges` is invalid.**
`artifactChanges` is required and must hold ≥1 change; each change requires
`replacements`; each replacement requires a `deletedRegion`. So the moment you
emit a `fix`, you have committed to naming a concrete region to edit. There is
no "description-only fix" — advisory-only guidance belongs on the *rule*
(`reportingDescriptor.help` / `fullDescription`) or in `result.message`, not in
`fixes[]`. See [autofix-consumption.md](./autofix-consumption.md).

## Approaches

### A concrete replacement (delete a region, insert new content)

**When to use:** You know the exact region to change and the exact replacement
text. This is the normal, autofix-able case.

**Pattern** (adapted from the SDK's `TwoResultsWithFixes.sarif`):

```json
{
  "description": { "text": "Convert tag name to lowercase." },
  "artifactChanges": [
    {
      "artifactLocation": { "uri": "src/index.html" },
      "replacements": [
        {
          "deletedRegion": { "startLine": 24, "startColumn": 4, "endColumn": 7 },
          "insertedContent": { "text": "div" }
        }
      ]
    }
  ]
}
```

**Gotchas:**
- `deletedRegion` is a `region` (§3.30) — it may be text (`startLine`/`startColumn`/
  `endColumn` or `charOffset`/`charLength`) **or** binary (`byteOffset`/`byteLength`),
  but not a mix. Pick one coordinate system per region.
- Text region → `insertedContent.text` (UTF-8). Binary region →
  `insertedContent.binary` (Base64). This pairing is a spec constraint (§3.57.2),
  not a style choice.

### A pure insertion (zero-length region)

**When to use:** You are adding content without removing anything — e.g. wrapping
an attribute value in quotes.

**Pattern** (from `TwoResultsWithFixes.sarif` — insert a `'` at a byte offset):

```json
{
  "description": { "text": "Wrap attribute value in single quotes." },
  "artifactChanges": [
    {
      "artifactLocation": { "uri": "src/index.html" },
      "replacements": [
        { "deletedRegion": { "byteOffset": 720 }, "insertedContent": { "binary": "Jw==" } },
        { "deletedRegion": { "byteOffset": 725 }, "insertedContent": { "binary": "Jw==" } }
      ]
    }
  ]
}
```

**Gotchas:**
- A `deletedRegion` with a length of zero (here, `byteOffset` with no
  `byteLength`) is an *insertion point*, not a deletion (§3.57.1).
- Multiple `replacements` in one `artifactChange` apply in array order, and each
  `deletedRegion` is expressed against the **unmodified** artifact — do not
  pre-adjust later offsets for earlier edits (§3.57.1).

### A pure deletion (region, no insertedContent)

**When to use:** Remove code with nothing replacing it.

**Pattern:**

```json
{
  "description": { "text": "Remove the redundant attribute." },
  "artifactChanges": [
    {
      "artifactLocation": { "uri": "src/index.html" },
      "replacements": [ { "deletedRegion": { "charOffset": 312, "charLength": 14 } } ]
    }
  ]
}
```

**Gotchas:**
- Omitting `insertedContent` (or giving it zero-length content) means "insert
  nothing" (§3.57.4) — a valid deletion.

### Alternative fixes (offer more than one)

**When to use:** Several distinct repairs are reasonable; let the consumer choose.

**Pattern:** `fixes[]` holds multiple `fix` objects — e.g. the SDK sample offers
both "wrap in single quotes" and "wrap in double quotes" as two entries. Each is
a complete, independently-applicable `fix`.

**Gotchas:**
- Each `fix` must stand alone and fully repair the finding; they are
  alternatives, not steps to combine.

## Decision guide

| Situation | Do this |
|---|---|
| Exact edit known, text file | One `replacement`: text `deletedRegion` + `insertedContent.text` |
| Exact edit known, binary file | Text→ `byteOffset`/`byteLength` region + `insertedContent.binary` |
| Adding without removing | Zero-length `deletedRegion` (insertion point) + `insertedContent` |
| Removing without adding | `deletedRegion` only, no `insertedContent` |
| Several valid repairs | Multiple `fix` objects in `fixes[]` |
| You only have *advice*, not exact bytes | **Do not emit `fixes[]`** — use rule `help`/`fullDescription` or `message` |

## Rules

- `artifactChanges` is required and non-empty; `artifactLocation` and
  `replacements` are required on every change; `deletedRegion` is required on
  every replacement.
- `description` is `SHOULD` (present when possible) but never sufficient on its
  own — it does not satisfy the `artifactChanges` requirement.
- Text vs binary region and text vs binary `insertedContent` must match.
- A replacement should have a material effect — a non-empty region to delete, or
  non-empty content to insert, or both (§3.57.2).
- Offsets in a multi-replacement change are all relative to the original file.

## Anti-patterns

| Don't | Why it breaks |
|---|---|
| `"fixes": [ { "description": { "text": "Add an alt attribute." } } ]` | Invalid — no `artifactChanges`. Schema-rejected; consumers drop it. |
| Put remediation *guidance* prose in `fix.description` with a fabricated `deletedRegion` | You are asserting an exact edit you do not actually have — a wrong patch, worse than none. Guidance goes on the rule, not in a fix. |
| Text `deletedRegion` + `insertedContent.binary` (or vice-versa) | Violates §3.57.2; the replacement is ambiguous/undefined. |
| Adjust a later replacement's offset for an earlier edit in the same change | Offsets are against the unmodified file; the applier double-counts and corrupts output. |
| Combine two `fix` entries expecting both to apply | They are alternatives; a consumer applies exactly one. |

## See also

- [result-object.md](./result-object.md) — where `fixes[]` sits on the result
- [autofix-consumption.md](./autofix-consumption.md) — why prose belongs on the rule, and how consumers actually handle provided fixes vs generate their own
