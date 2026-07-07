# How consumers turn a result into a fix

A SARIF file is inert until something reads it. This doc is about the two things
that do — GitHub Copilot Autofix and general coding agents — and, specifically,
**which fields make a finding auto-fixable versus merely explained**. The
counter-intuitive headline: Copilot Autofix does **not** read your `fixes[]`. It
*generates* its own edit from the alert and the rule's help text. So the fields
that determine fix quality are often not the ones a tool author expects.

## What GitHub Copilot Autofix actually reads

When Autofix runs on a code-scanning alert, GitHub assembles an LLM prompt from
(GitHub Docs, "Responsible use of Copilot Autofix", §Performance):

- the alert data in SARIF format — the `result` (`ruleId`, `message`,
  `locations`, and any flow/related locations),
- source-code snippets around each source location, sink location, and any
  location referenced in the message or flow path,
- the first ~10 lines of each file involved,
- **the help text for the rule that produced the alert.**

The model then *writes* the code change and an explanation. Provided
`result.fixes[]` are **not** part of this pipeline — Autofix synthesizes the
edit; it does not apply a tool-supplied one.

Implication for a tool author who wants Autofix to produce good fixes:

| Invest in | Because Autofix reads it |
|---|---|
| `reportingDescriptor.help` / `fullDescription` on the rule | It is fed verbatim into the fix prompt — this is the biggest lever. |
| A specific, self-contained `result.message` | Snippets are pulled around locations *referenced in the message*. |
| Precise `locations` (and `relatedLocations` for flow) | Determines which source the model sees. |
| `result.fixes[]` | **It does not** — Autofix ignores provided fixes and generates its own. |

Partner (non-CodeQL) tools are supported by the *same* generate-from-alert
pipeline (GitHub Changelog, "Copilot Autofix now supports partner code scanning
tools"). A tool-provided `fixes[]` block still is not the input; rule help text
and message quality are.

## Who *does* consume `fixes[]`

`fixes[]` is consumed by SARIF tooling that **applies** provided edits — IDE
SARIF viewers (e.g. the VS Code SARIF Viewer's "apply fix" affordance) and
CLI/CI tools that patch files from a SARIF log. For those consumers, a `fix`
with concrete `artifactChanges`/`replacements` is directly actionable; a
prose-only `fix` is invalid and ignored (see [fixes.md](./fixes.md)).

## Auto-fixable vs advisory — the two shapes

| Goal | Emit | Consumer behavior |
|---|---|---|
| Autofix / an agent should *generate* a correct edit | Rich rule `help`/`fullDescription`, specific `message`, precise `locations` | Autofix builds the patch from this context; agents ground their edit in it |
| A SARIF-viewer / patch tool should *apply* an exact edit you already computed | `result.fixes[]` with real `artifactChanges` + `replacements` | Viewer offers a one-click apply; CI can patch |
| Explain the problem, propose no concrete edit | `message` + rule `help`; **no `fixes[]`** | Rendered as an advisory alert; Autofix may still generate a fix from the help text |

The middle row and the top row are independent: you can ship advisory-only
findings (no `fixes[]`) and still be fully auto-fixable by Autofix, because
Autofix works off the *rule help and message*, not off `fixes[]`.

## What coding agents read

A coding agent handed a SARIF log treats it as structured findings, not as a
patch feed. The high-signal fields for an agent are the same ones Autofix
leans on: `ruleId` + rule `help`/`fullDescription` (what the rule means and how
to fix its class of problem), `message` (this instance), `locations` (where),
and `relatedLocations` (supporting context / data flow). A provided `fix` is a
*hint* an agent may read, but agents generally re-derive the edit against the
live tree rather than apply bytes blind.

## Rules

- To maximize Autofix quality, invest in `reportingDescriptor.help` /
  `fullDescription` and a specific `message` — those are the prompt inputs.
- Do **not** rely on `result.fixes[]` reaching Copilot Autofix; it is ignored by
  that pipeline.
- Emit `fixes[]` only when you have a concrete, applicable edit for
  SARIF-viewer/patch-tool consumers — and then it must be a real
  `artifactChanges`/`replacements`, never prose-only.
- A finding with no `fixes[]` is still auto-fixable and agent-actionable if its
  rule help and message are strong.

## Anti-patterns

| Don't | Why it breaks |
|---|---|
| Stuff remediation guidance into `fix.description` to "reach Autofix" | Autofix never reads `fixes[]`; the guidance is invisible to it. Put it in rule `help`. |
| Leave `reportingDescriptor.help` empty and expect good autofixes | Help text is the prompt's fix-guidance source; without it, generation is weaker. |
| Fabricate `replacements` just to populate `fixes[]` | A wrong exact-edit is applied verbatim by patch tools — worse than no fix. |
| Assume partner-tool SARIF `fixes[]` are applied by GitHub | Partner support = the same generate-from-alert path; provided fixes are not applied. |

## See also

- [fixes.md](./fixes.md) — why a `fix` is never prose-only, and the exact `artifactChanges` shape
- [result-object.md](./result-object.md) — the `message`, `locations`, and rule-linking fields consumers read
