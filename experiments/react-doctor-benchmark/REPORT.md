# react-doctor-benchmark — a11y-checker vs millionco/react-doctor

Head-to-head on two real apps, two design systems, run **cold** (no `init`, no manual component declarations), in JSON mode over the same `.tsx` root. Reproduce with `tsx experiments/react-doctor-benchmark/run.ts`.

react-doctor `0.5.4`.

| cell | app | design system | a11y-checker | react-doctor |
|---|---|---|---:|---:|
| 1 | [senchabot](https://github.com/senchabot-opensource/monorepo) `apps/web` @ `729ae7b` | shadcn/ui (local barrel) | **12** | 4 |
| 2 | [ga-dev-tools](https://github.com/googleanalytics/ga-dev-tools) `src` @ `14217f4` | MUI v5 (direct import) | 4 | **15** |

The two cells point opposite directions on purpose — that is the honest finding. Neither tool dominates; they have **different rule coverage and different blind spots**, and the diff makes both legible.

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

| | react-doctor | a11y-checker |
|---|---:|---:|
| a11y findings | 4 | 12 |
| false positives | **2** | 0 |
| real bugs inside design-system wrappers | 0 | **11** |
| overlap | 1 | 1 |

- **Shared (1):** `role-has-required-aria-props` @ `_sidebar/entities-dropdown.tsx:50` — a `combobox` missing `aria-controls`. Literal-element bug, both catch it.
- **Only react-doctor (3):** `heading-has-content` @ `card.tsx:36` and `alert.tsx:40` — **both false positives**, `<hN {...props}/>` forwarding children through the spread (exactly what PR #13 suppresses); plus `prefer-tag-over-role` @ `page.tsx:520` (a real rule we lack).
- **Only a11y-checker (11):** every one a real unlabeled control — 5 unlabeled `<Input>` (incl. the `commands-list.tsx:34` search box) and 6 icon-only `<Button>` — living **inside design-system wrappers react-doctor cannot see**.

react-doctor's port is also internally inconsistent: its `anchor-has-content` bails on a `{...props}` spread, but `heading-has-content` does not — so spread headings flag while spread anchors don't.

## Cell 2 — ga-dev-tools (MUI): react-doctor's broader ruleset finds a real bug we miss, plus noise

| | react-doctor | a11y-checker |
|---|---:|---:|
| a11y findings | 15 | 4 |
| of which a noisy cluster | **12** (empty `<td>`) | 0 |
| real bug the other misses | 1 (unlabeled `<input>`) | 2 (MUI `<IconButton>`) |
| overlap | 1 | 1 |

- **Shared (1):** `ga-console.tsx:80` — a `<div onClick>` with no keyboard handler / interactive role. Both catch it.
- **Only react-doctor (13):** all `control-has-associated-label` — **a rule we don't have.** One is real and we miss it: `numeric-input.tsx:18`, a literal `<input type="numeric">` with no label. The other **12 are a false-positive cluster** — the rule fires on empty `<td className={collapseColumn}></td>` layout cells in `cart.tsx`, calling each "an interactive control with no label." A presentational table cell is not a control.
- **Only a11y-checker (2):** `button-no-name` on MUI `<IconButton>` — `Compatible.tsx:193` (an icon-only reset button, clearly real) and `cart-button.tsx:18`. react-doctor misses both: its `getElementType` returns `"IconButton"`, not `button`, so no rule fires.

The takeaway from cell 2 is two-sided and worth holding both halves:
1. **react-doctor has rules we lack.** `control-has-associated-label` catches a real unlabeled native `<input>` our enabled rule set doesn't. That's a genuine gap (see "What to adopt" #3).
2. **react-doctor is noisier when it does.** That same rule produced a 12-finding FP cluster on layout cells. The breadth has a precision cost.
3. **Our component resolution still uniquely fires** — even on MUI, on the `<IconButton>` wrappers it's structurally blind to.

## How react-doctor does a11y

- **jsx-a11y, ported to oxlint** (Rust). Each rule says so: `// Port of oxc_linter::rules::jsx_a11y::anchor_has_content`. ~40 rules, the standard set — broader than our enabled subset.
- **`getElementType` = the jsx-a11y mechanism, unchanged.** Honors a manual `settings['jsx-a11y'].components` name→tag map and `polymorphicPropName`, else falls back to the literal JSX name. No source-following, no auto-detection — so every design-system wrapper is invisible unless hand-configured.
- **a11y is 1 of 5 categories** (Bugs, Maintainability, Performance, Security, Accessibility). On these apps a11y is 4/114 and 15/184 of total findings — it's a general "React health" audit for agents, not an accessibility tool.
- **Product surface we lack:** oxlint speed, a language-server, a GitHub Action ("only new issues vs base"), an agent-skill install. **Message voice we should borrow:** impact-first ("Blind users can't…").

## Verdict

react-doctor is **broader, faster, and more polished as a product**, with a fuller jsx-a11y rule set — but on accessibility it carries **two structural costs we don't**: it's blind to every design-system wrapper (manual-config-only resolution), and it's noisier (false positives on spread headings and on layout table cells). Our edge — **source-level component resolution** — is the one thing that holds across both design systems: on shadcn and on MUI alike, we uniquely surface real bugs inside the components, which is where modern React a11y bugs actually live.

The honest one-liner: **a11y-checker finds the bugs inside your components that linters structurally can't; react-doctor finds more of the literal-element bugs (with more noise) as one slice of a broader health audit.** Different tools. The gap to close on our side is native-element label coverage (#3); the gap on theirs is the wrapper blind spot, which they can't close without a resolver.

## What to adopt (improver mode)

1. **Impact-first message voice** — lead with who is harmed, not the rule id. ([#14](../../../issues/14))
2. **`prefer-tag-over-role`** — `role="region"` → `<section>`, etc. ([#15](../../../issues/15))
3. **Native-control label coverage** — cell 2 shows we miss an unlabeled literal `<input>` because we don't run `control-has-associated-label`. Add a **tightened** version (scoped to genuine form controls — NOT every element, to avoid the empty-`<td>` FP cluster react-doctor ships). See [ADOPT.md](./ADOPT.md).
