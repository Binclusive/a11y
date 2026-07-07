# The result object

A `result` is one finding a tool reports — the atom of a SARIF run, living in
`runs[].results[]`. Everything a consumer (a viewer, GitHub code scanning, a
coding agent) shows about a single problem is read off this object: what rule
fired, how severe it is, the human-readable message, where in the source it
sits, related context, and any proposed fix. This doc is the shape of that
object and which of its many optional properties actually carry weight.

## The minimal valid result

Only `message` is required (SARIF 2.1.0 §3.27.11). Everything else is optional
with a default, but a result with no `ruleId` and no `locations` is nearly
useless to a consumer.

```json
{
  "ruleId": "WEB1066",
  "level": "error",
  "message": { "text": "The tag name is not lowercase." },
  "locations": [
    {
      "physicalLocation": {
        "artifactLocation": { "uri": "src/index.html" },
        "region": { "startLine": 24, "startColumn": 4, "endColumn": 38 }
      }
    }
  ]
}
```

## The load-bearing properties

| Property | Type | Default | What it does |
|---|---|---|---|
| `message` | `message` object (**required**) | — | The finding text. `message.text` (plain) and/or `message.markdown`. First sentence shown when space is limited. |
| `ruleId` | string | — | Stable id tying the result to a `reportingDescriptor` in `tool.driver.rules[]`. |
| `ruleIndex` | integer | `-1` | Array index of that rule descriptor — lets consumers resolve the rule without a string lookup. |
| `level` | `"none"\|"note"\|"warning"\|"error"` | `"warning"` | Severity. |
| `kind` | `"notApplicable"\|"pass"\|"fail"\|"review"\|"open"\|"informational"` | `"fail"` | Evaluation state. A passing check is `kind:"pass"`, not an absent result. |
| `locations` | array of `location` | `[]` | Where the problem is. **Specify exactly one** unless the problem inherently spans several (see Rules). |
| `relatedLocations` | array of `location` | `[]` | Secondary locations that help *understand* the result (not where it is). See [related-locations.md](./related-locations.md). |
| `fixes` | array of `fix` | `[]` | Proposed edits. A `fix` is a code change, never prose-only. See [fixes.md](./fixes.md). |
| `partialFingerprints` | `{ [name]: string }` | — | Strings that contribute to a stable identity so a consumer can track the alert as lines move. |
| `fingerprints` | `{ [name]: string }` | — | Strings that each *fully* define a stable identity (stronger than partial). |
| `baselineState` | `"new"\|"unchanged"\|"updated"\|"absent"` | — | State relative to a previous run's baseline. |
| `rank` | number | `-1.0` | Priority/importance, 0–100. |
| `properties` | `propertyBag` | — | Tool-specific extension data — anything not modeled by SARIF goes here. |

## `message` — text vs markdown vs templated

Three ways to supply the text, all reading off the same `message` object
(§3.11):

```jsonc
// 1. Plain text — always safe, always understood.
{ "text": "The tag name is not lowercase." }

// 2. Markdown alongside plain text. Consumers that render markdown use it;
//    others fall back to `text`. Always provide `text` as the fallback.
{
  "text": "The tag name is not lowercase.",
  "markdown": "The tag name **is not lowercase**. Convert `<DIV>` to `<div>`."
}

// 3. Templated: reference a rule's messageStrings by id + substitute arguments.
//    `{0}`, `{1}` in the rule's string are replaced positionally.
{ "id": "default", "arguments": ["DIV"] }
```

For form (3) the rule descriptor carries the template:

```json
{ "id": "WEB1066",
  "messageStrings": { "default": { "text": "Convert the <{0}> tag to lowercase." } } }
```

## Decision guide

| Situation | Do this |
|---|---|
| One problem at one spot | One entry in `locations`, nothing in `relatedLocations` |
| Problem references a second spot to explain it | Primary in `locations`, secondary in `relatedLocations`, link via an embedded link in `message` |
| A check that passed | Emit a result with `kind:"pass"` (do not omit it) if the run reports passes |
| Tool data SARIF has no field for | Put it in `properties` |
| Track the same alert across commits | Set `partialFingerprints` from content, not line numbers |

## Rules

- `message` is the only required property; produce it always.
- `locations` **SHOULD** contain exactly one entry. Multiple locations mean "the
  problem cannot be described without all of them," not "several independent
  occurrences" — those are separate results (§3.27.12).
- `level` and `kind` are orthogonal: `kind` says whether the check failed;
  `level` says how bad a failure is. A `kind:"pass"` result's `level` is ignored.
- `partialFingerprints` should derive from stable content (e.g. a hash of the
  offending line), never from a line number — the point is to survive line moves.
- Unknown enum values are forbidden; `level` and `kind` are closed sets.

## Anti-patterns

| Don't | Why it breaks |
|---|---|
| Omit `message` | Invalid — it is the one required property. |
| Put several unrelated findings in one result's `locations[]` | A consumer renders one alert; the extra locations read as "all part of one problem." Emit separate results. |
| Encode severity in `message` text | Consumers filter and color by `level`; text severity is invisible to them. |
| Fingerprint on `startLine` | The alert re-appears as "new" on every unrelated edit above it. |
| Use `relatedLocations` for the primary spot | Consumers anchor the alert on `locations[0]`; a related location is context, not the site. |

## See also

- [fixes.md](./fixes.md) — the `fixes[]` property in full (why it is never prose-only)
- [related-locations.md](./related-locations.md) — `relatedLocations[]` and embedded links from `message`
- [autofix-consumption.md](./autofix-consumption.md) — which of these properties GitHub Copilot Autofix and coding agents actually read
