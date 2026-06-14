# Adopt — follow-ups from the react-doctor benchmark

Three things worth borrowing from react-doctor, surfaced by [REPORT.md](./REPORT.md). None touches the source-level component resolution that is our actual edge.

**Status:** #1 → [issue #14](../../../issues/14) · #2 → [issue #15](../../../issues/15) · #3 below is a draft (surfaced by the cell-2 MUI run; file when ready).

File a draft with:

```sh
gh issue create --title "<title>" --body-file -   # paste the body
```

---

## Issue 1 — adopt impact-first message voice

**Title:** `a11y: adopt impact-first message voice (react-doctor benchmark)`

### What they do

react-doctor leads each finding with **who is harmed and how**, not the rule id:

> "Blind users can't follow this link because screen readers announce nothing, so add visible text, `aria-label`, or `aria-labelledby`."

Ours leads with the rule / mechanism. The impact-first framing lands harder for the human (and the coding agent) reading the finding.

### Proposal

Rewrite finding messages to a consistent shape — **[who is affected] can't [do what] because [cause], so [fix]** — keeping our corpus "seen-in-the-wild" / WCAG SC data underneath as secondary lines. Cosmetic (no engine change) but high-leverage: it's the first thing every user reads. Aligns with "lead with user value, not the mechanism."

- [ ] Audit message strings across `enforce/*` + the jsx-a11y wrapper messages.
- [ ] Define the impact-first template; apply uniformly.
- [ ] Keep rule id / WCAG / corpus as secondary lines.

---

## Issue 2 — add `prefer-tag-over-role` rule

**Title:** `a11y: add prefer-tag-over-role rule (react-doctor benchmark)`

### What it caught that we missed

On senchabot, react-doctor fired one real rule we don't have:

> `prefer-tag-over-role` · `app/(landing)/page.tsx:520` — "Screen reader users get more reliable semantics from `<section>` than `role="region"`, so use `<section>` instead."

### Proposal

When an element uses an ARIA `role` that has a native HTML equivalent, recommend the native tag:

| `role=` | native |
|---|---|
| `region` | `<section>` |
| `button` | `<button>` |
| `navigation` | `<nav>` |
| `list` / `listitem` | `<ul>`/`<ol>` / `<li>` |
| `heading` | `<h1>`–`<h6>` |
| `article` | `<article>` |
| `banner` / `contentinfo` | `<header>` / `<footer>` |
| `main` | `<main>` |

Native semantics are more robust than role overlays (default keyboard behavior, no extra ARIA). A clean, deterministic static check that fits our `enforce/*` model (WCAG 1.3.1-adjacent).

- [ ] Add the role→tag mapping table.
- [ ] Fire on literal `role="…"` string literals (skip dynamic `role={x}`).
- [ ] Respect existing component resolution (the element may be a traced host).
- [ ] Corpus tier / WCAG SC tagging consistent with other rules.

---

## Issue 3 (draft) — native-control label coverage

**Title:** `a11y: catch unlabeled native form controls (control-has-associated-label gap)`

### What we missed

Cell 2 of the benchmark (MUI ga-dev-tools): react-doctor flagged a real bug we don't —

> `numeric-input.tsx:18` — a literal `<input type="numeric">` with no label, `aria-label`, or associated `<label for>`.

Our `enforce/input-no-name` fires on *resolved wrapper* controls, but a bare native `<input>` with no label slips through: we don't run jsx-a11y's `control-has-associated-label`, and `enforce` defers literals to jsx-a11y.

### The catch — do it TIGHTER than react-doctor

react-doctor runs the stock rule and pays for it: on the same app it produced a **12-finding false-positive cluster**, firing `control-has-associated-label` on empty `<td className={…}></td>` layout cells ("this control has no label" on a presentational table cell). The breadth imported the noise.

### Proposal

Add native-control label coverage **scoped to genuine form controls** — `<input>` (excluding `type=hidden|submit|button|reset|image`), `<select>`, `<textarea>` — not "every element," which is what makes the stock rule noisy. Reuse the same accessible-name logic `enforce/input-no-name` already has (aria-label / aria-labelledby / id+`<label for>` / wrapping `<label>` / title).

- [ ] Fire on unlabeled native `<input|select|textarea>` (skip non-name-bearing input types).
- [ ] Reuse the `enforce/*-no-name` accessible-name checks; do NOT flag layout elements.
- [ ] Add a fixture from `numeric-input.tsx` (real) + an empty-`<td>` (must NOT flag — the react-doctor FP).
- [ ] Corpus tier / WCAG SC (1.3.1 / 3.3.2) tagging consistent with `input-no-name`.
