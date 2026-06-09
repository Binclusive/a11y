# Turkcell — Live Accessibility Findings (captured)

Tool: `@binclusive/a11y` · `pnpm scan:url <url>` — renders the live URL in real
Chromium, runs axe-core against the **rendered DOM**, and enriches **every** finding
with severity + fix + reference. Where we have audit data it also carries a
corpus-frequency tier ("N/26 orgs"); otherwise it resolves to a BASELINE entry
(an axe-catalog WCAG SC, or `best-practice (no WCAG SC)` for axe best-practice
rules). No source code is used; this is the live-URL / customer-audit path.

**No finding dead-ends — UNMAPPED is gone.** Every row prints a severity, a fix,
and a reference.

Captured: 2026-06-08 (current tool). Three Turkcell pages, all rendered successfully.
Raw CLI logs: `raw-home.txt`, `raw-yardim.txt`, `raw-urunler.txt` (same dir).

---

## Overall rollup (3 pages)

| Page | URL | Total | Critical | Serious | Moderate | Minor | color-contrast nodes |
|---|---|---:|---:|---:|---:|---:|---:|
| Homepage | `/` | **63** | 0 | 58 | 5 | 0 | **5** |
| Support | `/yardim` | **8** | 0 | 3 | 5 | 0 | **3** |
| Phones (listing) | `/cep-telefonlari` | **13** | 1 | 9 | 3 | 0 | **8** |
| **Total** | | **84** | **1** | **70** | **13** | **0** | **16** |

**Bucketing (the tool's own rollup line per page):**

| Page | Tool rollup |
|---|---|
| Homepage `/` | `63 finding(s)  VERY COMMON: 53 \| BASELINE: 10` |
| Phones `/cep-telefonlari` | `13 finding(s)  BASELINE: 12 \| COMMON: 1` |
| Support `/yardim` | `8 finding(s)  BASELINE: 8` |
| **Across pages** | **AUDIT (VERY COMMON 53 + COMMON 1) = 54 · BASELINE = 30 · UNMAPPED = 0** |

- **UNMAPPED: 0 on every page.** The best-practice axe rules that previously
  dead-ended (`heading-order`, `region`, `landmark-*`, `page-has-heading-one`) now
  resolve to a BASELINE entry labeled `best-practice (no WCAG SC)`, each carrying a
  severity (MODERATE), a fix, and a Deque reference.
- **Every finding is blocking** under the default contract (84 blocking · 0 warning).
- **color-contrast (WCAG 1.4.3) fired on all three pages — 16 nodes total.** This is
  the headline: contrast is a *rendered-pixel* check. A static linter / type-checker
  reading the JSX cannot compute the actual foreground-vs-background color of a shipped
  component; we render the real page and measure it.

---

## Page 1 — Homepage `https://www.turkcell.com.tr/`  (PRIMARY)

**63 findings · 58 serious · 5 moderate.** Tool rollup:
`63 finding(s)  VERY COMMON: 53 | BASELINE: 10` · `63 blocking · 0 warning`.

| Count | Rule | Severity | What + fix | Bucket |
|---:|---|---|---|---|
| 45 | `aria-hidden-focus` | SERIOUS | Off-screen carousel slides are marked `aria-hidden="true"` but their links stay keyboard-focusable, so keyboard users tab into invisible content. Fix: make hidden slides non-focusable (`inert` / `tabindex=-1`). | **AUDIT · VERY COMMON · 21/26 orgs** (SC 4.1.2) |
| 7 | `aria-prohibited-attr` | SERIOUS | An ARIA attribute is set on an element that does not allow it, so assistive tech may ignore or misread it. Fix: remove the prohibited attribute / use a role that permits it. | **AUDIT · VERY COMMON · 21/26 orgs** (SC 4.1.2) |
| 5 | `color-contrast` | SERIOUS | Text fails the 4.5:1 minimum contrast ratio, so low-vision users can't read it. Fix: darken text or lighten background to pass 1.4.3. | BASELINE (SC 1.4.3) |
| 1 | `link-name` | SERIOUS | A carousel link has no discernible text, so the screen reader announces "link" with no destination. Fix: add `aria-label` / visible text. | **AUDIT · VERY COMMON · 21/26 orgs** (SC 4.1.2) |
| 1 | `heading-order` | MODERATE | Heading levels skip (e.g. h2 to h4), breaking the screen-reader outline. Fix: heading levels should only increase by one. | BASELINE · best-practice (no WCAG SC) |
| 1 | `landmark-unique` | MODERATE | Two landmarks share the same role+name, making "skip to" navigation ambiguous. Fix: give each a unique role/label combination. | BASELINE · best-practice (no WCAG SC) |
| 1 | `landmark-main-is-top-level` | MODERATE | `<main>` is nested inside another landmark. Fix: hoist it to top level. | BASELINE · best-practice (no WCAG SC) |
| 1 | `landmark-no-duplicate-main` | MODERATE | More than one `<main>` on the page. Fix: keep exactly one. | BASELINE · best-practice (no WCAG SC) |
| 1 | `region` | MODERATE | Content sits outside any landmark, so it's unreachable by landmark navigation. Fix: wrap all content in landmarks. | BASELINE · best-practice (no WCAG SC) |

> The 45 `aria-hidden-focus` hits are concentrated in the site's **slick / Ant Design
> carousels** — Banner, AppsWorld, BrandCampaigns, News, and PopularArticles sliders.
> The widget hides off-screen slides for sighted users but leaves their links in the
> keyboard tab order. This is invisible to source linters and only appears once the
> carousel actually renders and clones its slides.

---

## Page 2 — Support `https://www.turkcell.com.tr/yardim`

**8 findings · 3 serious · 5 moderate.** Tool rollup:
`8 finding(s)  BASELINE: 8` · `8 blocking · 0 warning`.

| Count | Rule | Severity | What + fix | Bucket |
|---:|---|---|---|---|
| 3 | `color-contrast` | SERIOUS | Text below 4.5:1 contrast. Fix: adjust colors to pass 1.4.3. | BASELINE (SC 1.4.3) |
| 2 | `landmark-unique` | MODERATE | Duplicate landmark role+name. Fix: give each a unique role/label combination. | BASELINE · best-practice (no WCAG SC) |
| 1 | `landmark-main-is-top-level` | MODERATE | `<main>` nested inside another landmark. Fix: hoist to top level. | BASELINE · best-practice (no WCAG SC) |
| 1 | `landmark-no-duplicate-main` | MODERATE | More than one `<main>`. Fix: keep one. | BASELINE · best-practice (no WCAG SC) |
| 1 | `region` | MODERATE | Content outside any landmark. Fix: wrap all content in landmarks. | BASELINE · best-practice (no WCAG SC) |

---

## Page 3 — Phones listing `https://www.turkcell.com.tr/cep-telefonlari`

**13 findings · 1 critical · 9 serious · 3 moderate.** Tool rollup:
`13 finding(s)  BASELINE: 12 | COMMON: 1` · `13 blocking · 0 warning`.

| Count | Rule | Severity | What + fix | Bucket |
|---:|---|---|---|---|
| 8 | `color-contrast` | SERIOUS | Text below 4.5:1 contrast (incl. nav links, language flags). Fix: adjust colors to pass 1.4.3. | BASELINE (SC 1.4.3) |
| 1 | `image-alt` | CRITICAL | A product image has **no alt text**, so screen-reader users get nothing. Fix: add descriptive alt (or empty alt if decorative). | **AUDIT · COMMON · 16/26 orgs** (SC 1.1.1) |
| 1 | `document-title` | SERIOUS | Page has no `<title>`, so the tab/bookmark/search-result label is missing. Fix: add a `<title>`. | BASELINE (SC 2.4.2) |
| 1 | `meta-viewport` | MODERATE | Viewport disables zoom, so mobile low-vision users can't pinch-zoom. Fix: allow user scaling. | BASELINE (SC 1.4.4) |
| 1 | `page-has-heading-one` | MODERATE | No `<h1>` on the page. Fix: add a top-level heading. | BASELINE · best-practice (no WCAG SC) |
| 1 | `landmark-unique` | MODERATE | Duplicate landmark role+name. Fix: give each a unique role/label combination. | BASELINE · best-practice (no WCAG SC) |

---

## 4 concrete examples (CEO-legible)

1. **The carousel keyboard trap** (homepage, 45x SERIOUS)
   - Selector: `.Banner_carousel__FnWKy > .ant-carousel > .slick-slider > … > .slick-slide[aria-hidden="true"]`
   - Human: the homepage hero/banner slider hides the slides you're not looking at, but a
     keyboard user pressing Tab still lands on the links inside those hidden slides — they
     "disappear" off-screen with no way to tell where focus went.
   - Fix: mark hidden slides `inert` so their links leave the tab order.
   - **Why a linter misses it:** the slides are cloned and hidden *at runtime* by the
     carousel JS — there is no static `aria-hidden` in the source to grep for.

2. **The unreadable text** (all 3 pages, 16x SERIOUS)
   - Example selectors: `.HeaderStatusBar_link__LH2lb` (homepage), `a[title="Kurumsal"]`,
     `.uxr-en-flag > span` (phones page language flags).
   - Human: header links and the language flags don't have enough contrast against their
     background — low-vision users can't read them.
   - Fix: darken the text / lighten the background to hit the 4.5:1 ratio (WCAG 1.4.3).
   - **Why a linter misses it:** contrast is a property of the *rendered pixels* — the
     final computed CSS color over the final computed background. Only a real render can measure it.

3. **The product image with no description** (phones page, 1x CRITICAL)
   - Selector: `.container > img`
   - Human: a product image has no alt text, so a blind shopper hears nothing where the
     phone should be. This is the single CRITICAL finding in the run.
   - Fix: add descriptive `alt` text (WCAG 1.1.1). Corpus: COMMON — 16/26 audited orgs ship this same gap.

4. **The nameless link** (homepage, 1x SERIOUS)
   - Selector: `.Banner_carousel__FnWKy > … > .slick-slide` (a carousel slide link)
   - Human: a banner link has no text or label at all — a screen reader just says "link,"
     with no hint of where it goes.
   - Fix: give the control an accessible name (`aria-label` or visible text).
   - Corpus: VERY COMMON — 21/26 audited orgs (SC 4.1.2).

---

## Honesty notes

- Counts are the tool's exact output — no rounding, no invented severities.
- **UNMAPPED is 0 on every page.** Findings that previously dead-ended (axe best-practice
  rules with no WCAG SC) now resolve to a BASELINE entry labeled
  `best-practice (no WCAG SC)`, each with a severity, fix, and Deque reference. They are
  real axe violations, counted in the totals (homepage 5, support 5, phones 2).
- **AUDIT** tiers (VERY COMMON / COMMON, with `N/26 orgs`) come from our real audit-frequency
  corpus — the moat. **BASELINE** tiers come from axe's published per-rule catalog (severity +
  fix + Deque ref): either a mapped WCAG SC or a best-practice rule. The tool labels them
  distinctly so baseline coverage is never mistaken for corpus frequency.
- All three pages rendered cleanly in real Chromium; none were bot-blocked or timed out.
