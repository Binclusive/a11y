# react-doctor-benchmark — a11y-checker vs millionco/react-doctor

Head-to-head on two real apps, two design systems, run **cold** (no `init`, no manual component declarations), in JSON mode over the same `.tsx` root. Reproduce with `tsx experiments/react-doctor-benchmark/run.ts`.

react-doctor `0.5.4`.

| cell | app | design system | a11y-checker | react-doctor |
|---|---|---|---:|---:|
| 1 | [senchabot](https://github.com/senchabot-opensource/monorepo) `apps/web` @ `729ae7b` | shadcn/ui (local barrel) | **13** | 4 |
| 2 | [ga-dev-tools](https://github.com/googleanalytics/ga-dev-tools) `src` @ `14217f4` | MUI v5 (direct import) | 5 | **15** |

The two cells point in different directions — that is the honest finding. They have **different rule coverage and different blind spots**, and the diff makes both legible. Both real-finding gaps this benchmark exposed are now closed in this PR: the unlabelled native `<input>` ([#16](../../../issues/16)) and the `prefer-tag-over-role` landmark rule ([#15](../../../issues/15)). **After both, every finding unique to react-doctor across the two cells is a false positive** — 2 spread-heading FPs on cell 1, 12 empty-`<td>` FPs on cell 2 — while every *real* finding it has is now shared, and we still uniquely surface 13 wrapper/landmark bugs it is structurally blind to.

## Improvement from PR #13 (the reason this benchmark exists post-fix)

PR #13 (barrel-origin classification + `{...props}` content-FP suppression) measured on senchabot `apps/web`:

| metric | before (main) | after (PR #13) | Δ |
|---|---:|---:|---:|
| a11y findings | 17 | 12 | **−5, all false positives** |
| false positives | 5 | **0** | −5 |
| coverage · `declare` | 93 | 55 | **−41%** |
| coverage · `trusted` | 34 | 65 | **+91%** |
| coverage · `structural` | 0 | 8 | +8 |
| `init --suggest` | mapped 1 of 21 | DS auto-recognized | — |

Before the fix we'd have shipped **5 false positives** on senchabot — *more* than react-doctor's 2. After it, **0**. The fix is what flips cell 1 from "noisier than react-doctor" to "0 FPs and 11 real bugs it can't see."

## Cell 1 — senchabot (shadcn): our component resolution wins

| | react-doctor | a11y-checker (after #15) |
|---|---:|---:|
| a11y findings | 4 | 13 |
| false positives | **2** | 0 |
| real bugs inside design-system wrappers | 0 | **11** |
| overlap | 2 | 2 |

- **Shared (2):** `role-has-required-aria-props` @ `entities-dropdown.tsx:50` (a `combobox` missing `aria-controls`); and `prefer-tag-over-role` @ `page.tsx:520` — a `<div role="region">` that should be `<section>`. The second was react-doctor-only until [#15](../../../issues/15) added a *scoped* version of that rule; we now catch it too (reporting the role-attribute line, so it aligns to the same site).
- **Only react-doctor (2):** `heading-has-content` @ `card.tsx:36` and `alert.tsx:40` — **both false positives**, `<hN {...props}/>` forwarding children through the spread (what PR #13 suppresses). After #15, react-doctor's *entire* unique-to-it set on this cell is these two FPs.
- **Only a11y-checker (11):** every one a real unlabeled control — 5 unlabeled `<Input>` (incl. the `commands-list.tsx:34` search box) and 6 icon-only `<Button>` — living **inside design-system wrappers react-doctor cannot see**.

Note our `prefer-tag-over-role` is *scoped*: it does **not** fire on `entities-dropdown.tsx:48` (`<Button role="combobox">`), because `combobox` has no clean native tag — the stock jsx-a11y rule would (suggesting `<input list>`), and over all roles it is ~90% noise (`<svg role="img" aria-label>` → "use `<img>`", `role="status"`, etc.). We ship only the landmark/structural slice. react-doctor's port is also internally inconsistent: its `anchor-has-content` bails on a `{...props}` spread, but `heading-has-content` does not.

## Cell 2 — ga-dev-tools (MUI): the gap we found here is now closed; react-doctor's lead is now pure noise

This cell was the honest counter-weight: the first run showed react-doctor 15, a11y-checker 4, because react-doctor's broader rule set caught a real unlabeled native `<input>` our enabled rules didn't. **Issue #16 (implemented in this PR) closes that gap** — native `<input>`/`<select>`/`<textarea>` now get the conservative `input-no-name` check — *without* importing react-doctor's noise.

| | react-doctor | a11y-checker (after #16) |
|---|---:|---:|
| a11y findings | 15 | 5 |
| of which a noisy cluster | **12** (empty `<td>`) | 0 |
| real bug the other misses | **0** | 2 (MUI `<IconButton>`) |
| overlap | 2 | 2 |

- **Shared (2):** `ga-console.tsx:80` — a `<div onClick>` with no keyboard handler; and `numeric-input.tsx:18` — the unlabeled native `<input>`. After #16 we catch the input too, so it moves from react-doctor-only to shared.
- **Only react-doctor (12):** **all `control-has-associated-label`, all in `cart.tsx`, all a false-positive cluster** — the rule fires on empty `<td className={collapseColumn}></td>` layout cells, calling each "an interactive control with no label." A presentational table cell is not a control. After #16, react-doctor's *entire* remaining lead on this cell is this one noise cluster.
- **Only a11y-checker (2):** `button-no-name` on MUI `<IconButton>` — `Compatible.tsx:193` (an icon-only reset button, clearly real) and `cart-button.tsx:18`. react-doctor misses both: its `getElementType` returns `"IconButton"`, not `button`, so no rule fires.

The takeaway from cell 2, post-#16:
1. **We closed the one real gap it exposed** — and did it *tighter*: a 15-repo wide sample showed the native-control path at ~100% precision after exempting hidden / `tabIndex={-1}` / `type=submit` controls. react-doctor's stock rule, on the same app, produces the 12-`<td>` cluster.
2. **Our component resolution still uniquely fires** — even on MUI, on the `<IconButton>` wrappers react-doctor is structurally blind to.

## How react-doctor does a11y

- **jsx-a11y, ported to oxlint** (Rust). Each rule says so: `// Port of oxc_linter::rules::jsx_a11y::anchor_has_content`. ~40 rules, the standard set — broader than our enabled subset.
- **`getElementType` = the jsx-a11y mechanism, unchanged.** Honors a manual `settings['jsx-a11y'].components` name→tag map and `polymorphicPropName`, else falls back to the literal JSX name. No source-following, no auto-detection — so every design-system wrapper is invisible unless hand-configured.
- **a11y is 1 of 5 categories** (Bugs, Maintainability, Performance, Security, Accessibility). On these apps a11y is 4/114 and 15/184 of total findings — it's a general "React health" audit for agents, not an accessibility tool.
- **Product surface we lack:** oxlint speed, a language-server, a GitHub Action ("only new issues vs base"), an agent-skill install. **Message voice we should borrow:** impact-first ("Blind users can't…").

## Verdict

react-doctor is **broader, faster, and more polished as a product**, with a fuller jsx-a11y rule set — but on accessibility it carries **two structural costs we don't**: it's blind to every design-system wrapper (manual-config-only resolution), and it's noisier (false positives on spread headings and on layout table cells). Our edge — **source-level component resolution** — is the one thing that holds across both design systems: on shadcn and on MUI alike, we uniquely surface real bugs inside the components, which is where modern React a11y bugs actually live.

The honest one-liner: **a11y-checker finds the bugs inside your components that linters structurally can't; react-doctor finds more of the literal-element bugs (with more noise) as one slice of a broader health audit.** Different tools. The one native-element gap cell 2 exposed is now closed (#16) — and closed *tighter* than react-doctor; the gap on theirs is the wrapper blind spot, which they can't close without a resolver.

## What to adopt (improver mode)

1. **Impact-first message voice** — lead with who is harmed, not the rule id. ([#14](../../../issues/14))
2. ~~**`prefer-tag-over-role`**~~ — **done (#15, this PR).** `enforce/prefer-tag-over-role`, scoped to landmark/structural roles (region→`<section>`, navigation→`<nav>`, list→`<ul>`, button→`<button>`, …) on bare intrinsics only. We deliberately did **not** enable jsx-a11y's stock rule: over all roles it is ~90% noise (12 clean landmark findings vs 89 from the stock rule, on the same repo sample).
3. ~~**Native-control label coverage**~~ — **done (#16, this PR).** Native `<input>`/`<select>`/`<textarea>` now get the conservative `input-no-name` check, scoped to genuine form controls with hidden / `tabIndex={-1}` / name-by-value exemptions — ~100% precision on a 15-repo sample, and structurally incapable of the empty-`<td>` cluster react-doctor ships.
