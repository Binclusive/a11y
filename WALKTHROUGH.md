# Walkthrough: adopting it with your own design system

Almost nobody ships raw MUI or Radix. Real apps have their *own* design system — `@acme/ui`, `@discord/components`, whatever. So this is the real adoption story, start to finish: how the checker meets a team like that, from the first cold scan to running quietly behind every commit.

The cast: **Acme Corp**, a Next.js app, their own `@acme/ui` (Button, IconButton, TextField, Link, Modal, Dropdown, …). The checker has never seen `@acme/ui`.

---

## Step 0 — the first scan (honest, and a little underwhelming)

```bash
pnpm scan ./src
```

```
a11y coverage:
  checked  18   — elements we inspected (findings come from here)
  declare  240  — unrecognized; declare in binclusive.json to inspect them:
    Button (from @acme/ui) — Declare it: binclusive.json → "components": { "Button": "button|a|input|..." }
    IconButton (from @acme/ui) — Declare it: binclusive.json → "components": { "IconButton": "button|a|..." }
    TextField (from @acme/ui) — Declare it: binclusive.json → "components": { "TextField": "input|..." }
    Link (from @acme/ui) — Declare it: binclusive.json → "components": { "Link": "a|..." }
    ... + 14 more from @acme/ui

11 finding(s)   VERY COMMON: 9  |  COMMON: 2
enforcement: 11 blocking · 0 warning
```

**What just happened.** The checker sees the HTML it can see — intrinsic `<button>`/`<a>`/`<img>` and anything it can trace — and finds 11 *real* issues there (a `<div onClick>`, a missing `alt`), **zero false positives**. But `@acme/ui` is a black box to it, so all of Acme's components land in `declare`. Coverage looks low.

Two things to notice:
1. It didn't *pretend* to check Acme's components and wave them through. It said "I can't see these" — honestly.
2. It told Acme **exactly what to do** — one copy-paste line per component.

This is the "needs-config" state. It's about to get a lot more powerful.

---

## Step 1 — `init`: teach it your stack

```bash
pnpm a11y-checker init
```

```
a11y-checker init — /acme/app
  stack:       next (app router) · @acme/ui · ts
  enforcement: block 1.3.1, 4.1.2, 2.4.4
  wrote:       binclusive.json
  block:       AGENTS.md, CLAUDE.md
```

It detected the stack (including that `@acme/ui` is the dominant design system) and wrote two things:

- **`binclusive.json`** — the repo's committed accessibility policy. Out of the box: the corpus's *very-common* criteria (1.3.1, 4.1.2, 2.4.4) **block** the build; the rest **warn**.
- a managed block in **`AGENTS.md` / `CLAUDE.md`** — the corpus rules, in front of the AI before it writes a line (more on that in Step 4).

---

## Step 2 — declare your design system (the one real step)

> **Shortcut — don't hand-write this.** Run `a11y-checker init --suggest` and it scaffolds the whole `components` block for you: it guesses a host for each of your design-system primitives, marks the uncertain ones with `⚠ verify`, and leaves composites in `declare`. You just **review ~12 lines** (fix the `⚠`s) instead of authoring config from scratch. Everything below is what `--suggest` produces — shown the manual way so you can see what it's doing.

The `declare` bucket from Step 0 already handed Acme the lines. They add (or `--suggest` pre-fills) the **leaf primitives** — the components that really are *one* HTML element — to `binclusive.json`:

```jsonc
{
  "version": 1,
  "stack": { "framework": "next", "router": "app", "designSystem": "@acme/ui", "language": "ts" },
  "enforcement": { "block": ["1.3.1", "4.1.2", "2.4.4"], "warn": ["1.1.1", "2.1.1", "3.3.1", "3.3.2"] },
  "components": {
    "Button": "button",
    "IconButton": "button",
    "TextField": "input",
    "Link": "a",
    "Avatar": "img"
  }
}
```

They **don't** declare `Modal`, `Dropdown`, `Tabs` — those aren't a single element, they're bundles. Mapping them would lie, so they stay in `declare` (correctly). *(Tip: for primitives the checker can trace — a thin wrapper that just forwards props to one `<button>` — you don't even need to declare them; it figures those out itself. You only hand-declare the ones hidden behind indirection.)*

---

## Step 3 — re-scan: the recall win turns on

```bash
pnpm scan ./src
```

```
a11y coverage:
  checked  186  — elements we inspected (findings come from here)
  declare  41   — unrecognized; declare in binclusive.json to inspect them:
    Modal (from @acme/ui) — composite, no single host (leave as-is)

src/billing/PaymentForm.tsx
  PaymentForm.tsx:88
    rule:   enforce/input-no-name  [block]  (call-site content check)
    wcag:   1.3.1, 3.3.2
    corpus: [VERY COMMON] SC 1.3.1 — 22/26 orgs
    fix:    Associate every form field with a <label> via id (not placeholder-only)...

src/nav/Toolbar.tsx
  Toolbar.tsx:24
    rule:   enforce/button-no-name  [block]  (call-site content check)
    corpus: [VERY COMMON] SC 4.1.2 — 21/26 orgs
    fix:    Give every interactive control an accessible name (aria-label/aria-labelledby)...

53 finding(s)   VERY COMMON: 44  |  COMMON: 9
```

Coverage jumped from 18 to 186. And now the content check reaches *inside* `@acme/ui` — finding the bugs that were invisible before:

- `<TextField placeholder="Card number" />` — no label.
- `<IconButton><TrashIcon/></IconButton>` — no accessible name.
- `<Link><GitHubIcon/></Link>` — icon-only, no name.

**The realization Acme has here is the whole pitch:** *"`@acme/ui` is well-built. But how we **use** it isn't — and no linter we've ever run could see that, because they all trust the design system."* These are real bugs, each weighted by how common it is across real audits, each with a fix.

---

## Step 4 — wire it into how you actually work

The point isn't to run a CLI once. It's to make accessible code the default. Three surfaces, all fed by the same `binclusive.json`:

- **The AI reads it first.** `init` wrote the corpus rules + Acme's declared components into `AGENTS.md`/`CLAUDE.md`. Now when an Acme dev's AI assistant builds a new `<TextField>`, it already knows to give it a label — *before* it writes the code.
- **The hook fixes in flight.** A `PostToolUse` hook runs the checker the instant the AI edits a file and whispers any findings back into the same turn, so the AI corrects itself before the dev even reviews.
- **CI gates it.** `a11y-checker check ./src` in CI exits non-zero on a *block*-level finding. The policy lives in the committed `binclusive.json`, so it travels with the repo and every contributor gets the same gate.

---

## Step 5 — it compounds

- A new `@acme/ui` component appears in `declare` → one line to teach it.
- A team learns a convention → `a11y-checker learn "Our Modal needs a DialogTitle" --wcag 4.1.2` → it lands in `binclusive.json` *and* the AGENTS block, so the AI honors it from then on.
- The `declare` bucket trends toward zero as the team teaches the checker their library once.
- If Acme is a Binclusive audit customer, their audits feed the corpus — which sharpens the checker for *everyone*, Acme included.

---

## The shape of the whole thing

| When | What it costs | What you get |
|---|---|---|
| **Minute 0** | one command | honest cold scan: real structural bugs, zero false positives, an itemized list of what it can't see yet |
| **Minute 10** | `init` + declare ~5 primitives | coverage jumps; the recall win turns on; real bugs *inside* your own components |
| **Day 1 onward** | wire the hook + CI once | new code arrives accessible; the AI writes it right the first time; the build gates regressions |

The cold scan isn't the product. The product is the ten-minute on-ramp from "it can't see my design system" to "it's catching real bugs in my design system and stopping new ones at the source."
