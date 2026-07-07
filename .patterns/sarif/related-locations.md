# Related locations

`result.relatedLocations[]` holds locations that are **relevant to understanding
the result but are not where the result is** (§3.27.22). The canonical case: a
finding at spot A that only makes sense if you also point at spot B — a variable
declared elsewhere, the source of tainted data, the element a rule refers to.
This doc covers the `location` object those entries are, how a `message` deep-
links into them, and the `relationships` that type the A→B edge.

## The location object

Every entry in `relatedLocations[]` (and in `locations[]`) is a `location`
(§3.28). All properties are optional:

| Property | Type | What it does |
|---|---|---|
| `id` | integer | Distinguishes this location within the result. Needed **only** if a message embedded-link or a relationship targets it. Absent ⇒ defaults to `-1` (unset). |
| `physicalLocation` | `physicalLocation` | The file (`artifactLocation`) + optional `region`. |
| `logicalLocations` | array | Named program elements (a function, a DOM element) when there is no physical region. |
| `message` | `message` | Text explaining *why this location is relevant*. |
| `relationships` | array of `locationRelationship` | Typed edges from this location to other locations in the result. |
| `annotations` | array of `region` | Sub-regions worth highlighting within this location. |

`id` values must be non-negative and unique among the result's locations
(§3.28.2). Negative values are forbidden.

## Approaches

### A related location the message points at

**When to use:** The finding text needs to reference a second spot ("declared
here", "flows from here").

**Pattern** (adapted from the spec's variable-hiding example, §3.27.22): the
primary problem is at the inner declaration; a related location marks the outer
one, and the `message` links to it by `id` using an embedded link `[text](id)`.

```json
{
  "ruleId": "JS3056",
  "level": "error",
  "message": {
    "text": "Name 'index' cannot be used in this scope because it would shadow the variable [declared here](0)."
  },
  "locations": [
    { "physicalLocation": {
        "artifactLocation": { "uri": "src/a.js" },
        "region": { "startLine": 6, "startColumn": 10 } } }
  ],
  "relatedLocations": [
    {
      "id": 0,
      "message": { "text": "The previous declaration of 'index' was here." },
      "physicalLocation": {
        "artifactLocation": { "uri": "src/a.js" },
        "region": { "startLine": 2, "startColumn": 6 }
      }
    }
  ]
}
```

**Gotchas:**
- The embedded link `[declared here](0)` — the destination `0` is the related
  location's `id`, **not** a URL. In a plain-text `message`, this restricted
  `[text](id)` syntax is the only link form allowed (§3.11.6); in `markdown` you
  may use full GitHub-Flavored-Markdown links.
- A related location needs an `id` **only because** something references it. If
  nothing links to it, omit `id` (§3.28.2).
- Literal `[` / `]` in plain-text link text must be backslash-escaped.

### A related location with no incoming link

**When to use:** You want to surface extra context spots without wiring a link
from the message — a viewer lists them as "related."

**Pattern:** same shape, drop the `id` and the embedded link:

```json
{
  "relatedLocations": [
    { "message": { "text": "Untrusted data enters here." },
      "physicalLocation": { "artifactLocation": { "uri": "src/handler.py" },
                            "region": { "startLine": 38 } } }
  ]
}
```

**Gotchas:**
- Entries in `relatedLocations[]` must be **unique** (§3.27.22) — no duplicate
  location objects.

### Typed relationships between locations

**When to use:** The A→B edge has meaning worth naming (`includes`,
`isIncludedBy`, `relevant`).

**Pattern** (adapted from the spec's include-chain example, §3.34): a location
carries a `relationships[]` whose `target` is another location's `id`.

```json
{
  "locations": [
    { "id": 0,
      "physicalLocation": { "artifactLocation": { "uri": "f.h" },
                            "region": { "startLine": 42 } },
      "relationships": [ { "target": 1, "kinds": ["isIncludedBy"] } ] }
  ],
  "relatedLocations": [
    { "id": 1, "physicalLocation": { "artifactLocation": { "uri": "g.h" } } }
  ]
}
```

**Gotchas:**
- `target` is a location `id`, so both endpoints need an `id`.
- `kinds` well-known values are `includes`, `isIncludedBy`, `relevant`; other
  strings are allowed but consumers may ignore them.

## Decision guide

| Situation | Do this |
|---|---|
| Message must say "declared/flows/defined here" | Related location with `id` + `[text](id)` embedded link in `message` |
| Extra context spots, no inline reference | Related locations without `id` |
| The relationship type matters | `location.relationships[]` with `target` + `kinds` |
| Named element, no physical region | `logicalLocations` instead of `physicalLocation` |

## Rules

- `relatedLocations` is for understanding the result, never for the site of the
  result — that is `locations[]` (see [result-object.md](./result-object.md)).
- Give a location an `id` **iff** a message link or a relationship references it.
- `id` values are non-negative and unique within the result.
- Entries are unique; no duplicate location objects.
- A plain-text embedded link's destination is a location `id`; a markdown link's
  may be a full URI.

## Anti-patterns

| Don't | Why it breaks |
|---|---|
| `[declared here](https://…)` in a plain-text message meant to point at a related location | Plain-text embedded links target a location `id`, not a URL; the link won't resolve to the location. |
| Put the primary finding spot in `relatedLocations` | Consumers anchor the alert on `locations[0]`; the finding appears to have no site. |
| Reference `id: 3` from a message when no location has that `id` | Dangling link; viewers render broken or drop it. |
| Reuse the same `id` on two locations | `id` must be unique within the result; targeting becomes ambiguous. |

## See also

- [result-object.md](./result-object.md) — `locations` vs `relatedLocations`, and the `message` object
- [fixes.md](./fixes.md) — the other result-level array; note a fix's regions are *edits*, related locations are *context*
