# android-matrix — the Android XML real-world regression gate

SHA-pinned Android repos, re-scanned by the in-process Android XML layout
collector (`src/collect-android-xml.ts`) and diffed against a committed
`baseline.json`. This is the Android analog of `experiments/unity-matrix` /
`experiments/stack-matrix`: because every repo is frozen at an exact commit, the
**only** thing that can move the numbers is this checker's own code — so the
gate makes real-world drift in the Android path visible in review.

## What it gates

The **finding stream** the two shipped rules emit over each repo:

- `android-xml/image-no-label` (WCAG 1.1.1) — an `ImageView` / `ImageButton`
  with no `android:contentDescription`.
- `android-xml/control-no-name` (WCAG 4.1.2) — a `Button` / `ImageButton`, or a
  `clickable` element, with no accessible name (and no labeled descendant).

The committed record (`baseline.json`) pins the per-repo count, per-rule counts,
and the full sorted `file:line:ruleId` list, so a moved/added/removed finding is
a line-level diff.

## The corpus (manifest.json)

| repo | sha | what it exercises |
|------|-----|-------------------|
| `TeamNewPipe/NewPipe` | `46a5964…` | the prototype that motivated #109 — reproduces exactly **18 image-no-label + 9 control-no-name** |
| `AntennaPod/AntennaPod` | `f7f0314…` | a second large all-XML View-system app — **22 image-no-label + 9 control-no-name** |

> Note: AntennaPod's original prototype reference also carried a third
> `android-xml/editable-no-label` rule. That rule is **out of scope** for the
> two-rule collector this gate locks (#109), so the baseline records only the two
> shipped rules.

## Commands

```
pnpm android:matrix:run        # clone+scan each pinned repo → results/<slug>.json (gitignored)
pnpm android:matrix:baseline   # re-bless: results/ → baseline.json (the committed record)
pnpm android:matrix:check      # re-scan + diff vs baseline; exits non-zero on any movement
pnpm android:matrix:check --no-run   # re-diff existing results/ without re-cloning
```

A non-zero `check` is **not** automatically a bug — read the delta. If the
movement is intended (a rule now catches a real layout bug), re-bless with
`pnpm android:matrix:baseline` and commit the updated `baseline.json` **in the
same PR** as the code change, so the shift is visible. Never re-bless a delta you
have not understood — the committed `baseline.json` is the record that makes
real-world drift reviewable.

## Extending the corpus

Add a public Android app repo with real `res/layout*` XML, resolve its sha
(`git ls-remote https://github.com/<owner>/<repo> HEAD`), append an entry to
`manifest.json`, then re-bless with `pnpm android:matrix:baseline`.
