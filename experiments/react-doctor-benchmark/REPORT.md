# react-doctor-benchmark — a11y-checker vs millionco/react-doctor

Head-to-head on **[senchabot-opensource/monorepo](https://github.com/senchabot-opensource/monorepo)** `apps/web` (Next.js App Router + a hand-vendored shadcn/ui), pinned at `729ae7b`. Both tools run **cold** (no `init`, no manual component declarations), in JSON mode, over the same `apps/web/src`. Reproduce with `tsx experiments/react-doctor-benchmark/run.ts`.

react-doctor `0.5.4`.

## Headline

| | react-doctor | a11y-checker |
|---|---:|---:|
| **accessibility findings** | **4** | **12** |
| — false positives | **2** | **0** |
| — real bugs inside design-system wrappers | **0** | **11** |
| — overlapping (both find) | 1 | 1 |
| rules it has that we don't | `prefer-tag-over-role` | — |
| breadth | 5 categories (114 total findings) | a11y only, deep |
| engine | jsx-a11y ported to oxlint (Rust) | jsx-a11y (eslint) + corpus-grounded `enforce/*` |
| component resolution | manual `settings['jsx-a11y'].components` only | auto: traces wrappers → host primitive |

## The diff, by call site

**Shared (1)** — both tools agree:
- `role-has-required-aria-props` · `_sidebar/entities-dropdown.tsx:50` — a `combobox` missing `aria-controls`. Real, literal-element bug; jsx-a11y territory, caught by both.

**Only react-doctor (3):**
- `heading-has-content` · `components/ui/card.tsx:36` — **false positive.** `<h3 {...props}/>` forwards its children through the spread.
- `heading-has-content` · `components/ui/alert.tsx:40` — **false positive.** `<h5 {...props}/>`, same shape.
- `prefer-tag-over-role` · `app/(landing)/page.tsx:520` — real, and a rule **we don't have** (`role="region"` → `<section>`).

The two heading findings are the exact false positives `spreadChildrenLineRanges` suppresses (PR #13). react-doctor ships them as warnings. Note its port is *inconsistent*: its `anchor-has-content` bails on a `{...props}` spread (it does **not** flag `components/ui/link.tsx`'s `<a {...props}/>`), but `heading-has-content` does not — so spread headings flag while spread anchors don't.

**Only a11y-checker (11)** — every one is a real control with no accessible name, living **inside a design-system wrapper** react-doctor cannot see:

| rule | site | what |
|---|---|---|
| `input-no-name` | `app/commands/[channel]/commands-list.tsx:34` | a search `<Input>` with only a placeholder |
| `input-no-name` | `…/commands/@tabs/commands-list-client.tsx:54` | unlabeled `<Input>` |
| `input-no-name` | `…/@tabs/system/system-commands-list.tsx:84` | unlabeled `<Input>` |
| `input-no-name` | `…/custom-command-variables-list.tsx:51` | unlabeled `<Input>` |
| `input-no-name` | `…/settings/setting-text-input.tsx:44` | unlabeled `<Input>` |
| `button-no-name` | `app/(landing)/page.tsx:307` | icon-only `<Button>` |
| `button-no-name` | `…/delete-custom-command-variable-button.tsx:25` | icon-only `<Button>` |
| `button-no-name` | `…/update-custom-command-variable-dialog.tsx:37` | icon-only `<Button>` |
| `button-no-name` | `…/_sidebar/sidebar.tsx:49` | icon-only `<Button>` |
| `button-no-name` | `…/tools/sub-badge-creator/sub-badge-creator-client.tsx:318` | icon-only `<Button>` |
| `button-no-name` | `app/commands/[channel]/page.tsx:54` | icon-only control |

These are invisible to jsx-a11y/react-doctor because `<Input>` / `<Button>` are wrapper components; its `getElementType` only maps a wrapper to a host if you hand-write `settings['jsx-a11y'].components = { Input: "input", … }` for every primitive. a11y-checker resolves them from source automatically (registry + trace + barrel-origin), which is why coverage on this app is `checked 35 / trusted 65 / declare 55` rather than "literal elements only."

## How react-doctor does a11y

- **jsx-a11y, on oxlint.** Each rule is a faithful Rust-engine port — the source says so: `// Port of oxc_linter::rules::jsx_a11y::anchor_has_content`. ~40 rules, the standard jsx-a11y set.
- **`getElementType` = the jsx-a11y mechanism, unchanged.** Honors `settings['jsx-a11y'].components` (a manual name→tag map) and `polymorphicPropName`, else falls back to the literal JSX name. No source-following, no auto-detection.
- **a11y is one of five categories** (Bugs, Maintainability, Performance, Security, Accessibility). On this app a11y is 4 of 114 findings — it's a general "React health" audit for coding agents, not an accessibility tool.
- **Strong product surface** we don't have: oxlint speed, a language-server (in-editor), a GitHub Action ("only new issues vs base"), and an agent-skill install.
- **Better message voice.** "Blind users can't follow this link because screen readers announce nothing…" is impact-first and lands harder than a rule id.

## Verdict

react-doctor is **broader, faster, and more polished as a product**, but on accessibility specifically it is a **thin jsx-a11y layer**: it carries the design-system blind spot (misses all 11 real wrapper bugs here) and the `{...props}` heading false positives we have already engineered past. It is not competing on a11y depth; it is a different product.

The honest one-liner: **on this app, a11y-checker found every real accessibility bug react-doctor did, plus 11 it structurally cannot see, with zero of the 2 false positives react-doctor reported.**

## What to adopt (improver mode)

1. **Impact-first message voice** — rewrite findings to lead with who is harmed and how, not the rule id. (issue: message-voice)
2. **`prefer-tag-over-role`** — real rule we lack: `role="region"` → `<section>`, `role="button"` → `<button>`, etc. (issue: prefer-tag-over-role)

Both are cheap, both make findings land harder, and neither touches the resolution engine that is our actual edge.
