# Auditing HTML & live pages (non-React)

The `.tsx` scan is half the story. It needs React source on disk — but plenty of
pages don't have that: a deployed customer site, an ASP.NET/Razor app, a plain
HTML/Bootstrap/jQuery page, or any live URL you only have the *deployed* page for.

So the checker has a **second producer**. Instead of reading source, it renders
the real page in a browser and runs **axe-core** against the live DOM — then flows
every finding through the *same* corpus / WCAG / enforcement machinery as the
source scan. Same tiers, same fixes, same block/warn gate. The only thing that
changes is where the findings come from.

This is the source-less path: **one command audits any live site, React or not.**

---

## Step 0 — install the browser (one time)

The render path drives a real Chromium. Install it once:

```bash
pnpm exec playwright install chromium
```

That's the only extra setup the URL path needs over the `.tsx` scan.

---

## Step 1 — audit a live URL

Point it at a deployed site:

```bash
pnpm scan:url https://www.example.com
```

```
a11y-checker — rendering https://www.example.com and running axe-core

image-alt
  img.hero-logo
    rule:   image-alt  [block]  (rendered-DOM / axe)
    wcag:   WCAG 1.1.1
    Images must have alternate text
    corpus: [VERY COMMON] SC 1.1.1 — 24/26 orgs
    fix:    Give every meaningful image an alt that conveys its purpose...

color-contrast
  a.footer__link
    rule:   color-contrast  [warn]  (rendered-DOM / axe)
    wcag:   WCAG 1.4.3
    Elements must meet minimum color contrast ratio thresholds
    corpus: no snapshot match (tier unknown)

89 finding(s)   VERY COMMON: 61  |  COMMON: 4  |  UNKNOWN: 24
enforcement: 61 blocking · 28 warning
```

`example.com` is a live non-React site — ASP.NET Razor + jQuery, not a line of React. The
static `.tsx` scan finds **0** on it (there's no source to read). The render path
finds the real bugs, each tiered by how common it is across our audits.

`<target>` is flexible — all three of these work:

```bash
pnpm scan:url https://www.example.com     # a deployed site
pnpm scan:url http://localhost:5000     # your local dev server
pnpm scan:url ./wwwroot/index.html      # a local static .html file (bare path)
```

It accepts an `http(s)://` URL, a `file://` URL, **or** a bare local filesystem
path — the bare path is resolved and converted to `file://` for you.

---

## Step 2 — audit a local `.html` file

No server needed for a static page. Point it straight at the file:

```bash
pnpm scan:url ./test/fixtures/bootstrap-landing.html
```

A plain `.html` file (Bootstrap, hand-written, a static export) renders directly
via `file://`. The output is identical in shape to Step 1.

> **Templates are different — they need the running app.** A server-side
> *template* (`.cshtml` Razor, `.erb`, Handlebars, …) is **not** valid standalone
> HTML — it's `@`-directives, loops, and `{{interpolation}}` that only become real
> markup when the server renders them. So `file://` can't render a `.cshtml`. For
> those, run the app and point `check-url` at it:
>
> ```bash
> pnpm scan:url http://localhost:5000     # the running Razor app, not the .cshtml
> ```
>
> Rule of thumb: **plain `.html` → `file://` works; a template → point at
> `localhost`.**

---

## Step 3 — read the output

A rendered-DOM finding looks like this:

```
color-contrast
  a.footer__link
    rule:   color-contrast  [warn]  (rendered-DOM / axe)
    wcag:   WCAG 1.4.3
    Elements must meet minimum color contrast ratio thresholds
    corpus: no snapshot match (tier unknown)
```

Reading it line by line:

| Line | What it tells you |
|---|---|
| **`color-contrast`** (group header) | the axe rule. The DOM path has no file to group on (every finding shares one URL), so it groups by rule instead. |
| **`a.footer__link`** | the **anchor** — a CSS `selector` pointing at the offending node in the rendered page, the DOM equivalent of `file:line`. |
| **`(rendered-DOM / axe)`** | the **provenance tag** — this finding came from the render path, not the `.tsx` scan. (Source findings are tagged `(call-site content check)` or untagged.) |
| **`wcag: WCAG 1.4.3`** | the success criterion, read straight off axe's tags. |
| **`corpus: ...`** | the corpus match by SC — tier + how many of the 26 orgs hit it + the fix. |

---

## What it catches that source can't

A real browser render sees things static JSX analysis — and even headless DOMs
like jsdom — are structurally blind to:

- **color-contrast (WCAG 1.4.3)** — needs computed colors against rendered
  layout; you can't read it off source.
- **computed ARIA roles** — the role an element *actually* resolves to in the
  accessibility tree.
- **layout-dependent rules** — target size, reflow, anything that depends on the
  page as painted.

That's the whole reason the render path exists alongside the source scan: each
producer sees what the other can't.

---

## The honest edge — `UNKNOWN` tiers

The seed corpus snapshot currently covers **~10 success criteria**. The render
path surfaces some criteria that aren't in that snapshot yet — notably **1.4.3
(contrast), 1.4.1, 2.4.4**. Those findings **still appear** (the render catches
them regardless), but they roll up under tier `UNKNOWN`:

```
    corpus: no snapshot match (tier unknown)
```

No tier, no corpus fix text — just the axe rule, the selector, and the WCAG SC.
This isn't a bug; it's the corpus being honest about what it has snapshotted so
far. As the corpus is extended criterion by criterion, these graduate from
`UNKNOWN` into a real tier with a fix. The detection never waited on the corpus —
the finding was always there.

---

## Where this fits

The URL path is the same machinery as the source scan, swapped at the front:

```
.tsx source ─┐
             ├─→ enrichAll (corpus by WCAG SC) ─→ block/warn gate ─→ report
live DOM   ──┘
```

The source scan still owns the **recall win** — finding bugs *inside* your own
design-system components (see `WALKTHROUGH.md`). The URL path owns the
**source-less reach** — auditing any deployed page, React or not. Run the one that
matches what you have: `.tsx` on disk → `scan`; a URL or `.html` → `scan:url`.

The architecture rationale (why two collectors over one shared core, why
Playwright over jsdom) is in `.decisions/0001-rendered-dom-adapter.md`; the code
map is in `docs/ARCHITECTURE.md`.
