# Compose evidence A/B — does the Kotlin lane need type resolution?

The expensive-to-reverse question ADR 0006 left open for the Kotlin engine: do the
Compose rules need the **Analysis API** (type resolution), or does **plain PSI** suffice?
Settled empirically against **Now in Android** (`android/nowinandroid`, 310 `.kt`, 45
`@Composable` files) before the engine committed.

## What the corpus showed

`grep` of every `Icon(` / `Image(` call site and its `contentDescription`:

| contentDescription value | count | meaning |
|---|---:|---|
| `= variable` (incl. `stringResource(...)`) | 57 | named (a real description) |
| `= "literal"` | 2 | named |
| `= null` | many | decorative, OR the sole content of an unnamed control |

Two conclusions:

1. **`contentDescription` is always present — Compose's `Icon`/`Image` require it
   (compiler-enforced).** So the defect is never "missing"; it is **`= null` on an icon
   that is the sole content of an interactive control with no other name** — the exact
   SwiftUI climb, around the control instead of up the tree.

2. **Plain PSI suffices — no type resolution needed.** Deciding the rule reads only:
   the callee *name* (`IconButton` / `Icon` / `Text`), the *named argument*
   `contentDescription`, whether its value is the literal `null` vs an expression, and
   structural nesting (what is inside the content lambda). None of that needs a resolved
   type. This confirms ADR 0006's "PSI; Analysis API only where a rule needs a receiver's
   type" — and makes Compose the cheaper of the two Kotlin surfaces.

## The false-positive class the engine then exposed

Running the built engine on the same corpus surfaced exactly one finding —
`NiaIconToggleButton` (`core/designsystem/.../IconButton.kt`), a **false positive**: a
reusable wrapper whose content is `{ if (checked) checkedIcon() else icon() }`, where
`icon` is a `@Composable () -> Unit` **parameter**. The real `Icon` (and its name) is
supplied by the caller — invisible to static PSI. The rule now treats a content lambda
that invokes such a **slot** (or any custom composable) as **opaque, not nameless**, and
only flags when the content is *provably* nameless. After the fix: **0 findings on NiA**
(correct for an a11y-reference app); recall is held by the unit test that flags a real
`IconButton { Icon(..., contentDescription = null) }`.

## Recall validation — three real Compose apps

NiA proves *precision* (0 false positives on clean code) but not *recall* — it has no
real unnamed-icon-button defects. Two community Compose apps closed that gap:

| app | `.kt` | findings | verdict |
|---|---:|---:|---|
| android/nowinandroid | 310 | 0 | clean reference app (precision anchor) |
| JunkFood02/Seal | 140 | 2 | both true positives — `Icon(Icons.Outlined.Menu, null)` and `Icon(Icons.Outlined.Settings, null)` icon buttons, no name |
| Ashinch/ReadYou | 379 | 1 | true positive — a certificate-chooser `IconButton` holding only `Icon(Key, contentDescription = null)` |

**3/3 true positives** — the rule fires on genuine defects in real code, not just fixtures.

The recall run also surfaced a latent **precision** bug the clean app couldn't: Compose's
`contentDescription` is frequently passed POSITIONALLY (`Icon(Icons.Menu, null)` — the 2nd
positional arg), and the rule originally read only the *named* argument. The real nulls
were caught by luck, but a positional non-null description (`Icon(x, stringResource(...))`,
6 such call sites in Seal) would have been a false positive. Fixed: read the
`contentDescription` whether named or the 2nd positional arg. Re-scan after the fix held
all three results (NiA 0, Seal 2, ReadYou 1) — recall preserved, the latent FP closed.

## Bearing on the parser choice

Because the rules are syntactic, a tree-sitter CST *could* in principle serve — but the
official frontend (kotlin-compiler-embeddable) is what robustly handles Compose's
trailing-lambda / `@Composable` DSL, and the programmatic-View surface (lane 3) will
want the Analysis API for receiver types. So the JVM engine stands; the evidence simply
confirms Compose itself runs on plain PSI, no Analysis API.
