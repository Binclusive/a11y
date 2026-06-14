# Adopt — follow-ups from the react-doctor benchmark

Two things worth borrowing from react-doctor, surfaced by [REPORT.md](./REPORT.md). Both are cheap, both make findings land harder, and neither touches the source-level component resolution that is our actual edge.

These are drafted as ready-to-file GitHub issues. File with:

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
