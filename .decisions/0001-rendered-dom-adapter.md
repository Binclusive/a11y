---
id: 0001
title: Rendered-DOM / Live-URL Adapter via a Shared Rules Core
status: accepted
date: 2026-06-08
tags: [architecture, audit, adapters]
---

# 0001 — Rendered-DOM / Live-URL Adapter via a Shared Rules Core

## Context

The checker is hardwired to React/TSX: `collect.ts` filters `.tsx`, and
`core.ts::scan()` runs `eslint-plugin-jsx-a11y` + the call-site `enforce` pass +
`resolve-components` — all JSX-AST bound.

Evidence it under-covers real-world audit targets: fingerprinting 15 domains
from audited projects, ~8 of 14 reachable sites are **not** React (ASP.NET
Razor + jQuery, cookie-confirmed; classic `.aspx`; Apache; server-rendered).
The remaining 6 React sites are Next.js SSR.

The deeper point: our **audit** business scans live URLs we do not have source
for. The static JSX linter needs `.tsx` on disk; an audit gives a URL. So static
lint covers **0/14** for audits; render→axe covers **14/14**, React or not.

Proof on a live non-React site: static linter → 0 findings; render→axe (jsdom, structural
rules only) → 85 failing nodes across 6 rule-types (2 critical missing-alt,
4 serious empty image-links, 74 unlandmarked regions). jsdom even *skips*
color-contrast; a real browser surfaces more.

## Decision

Treat the React/TSX path and a new rendered-DOM / live-URL path as **two
collectors over one shared rules core**, not two products.

- **Shared core stays untouched** (it is already format-agnostic): the `Finding`
  type, `wcag-map.ts`, `corpus.ts::enrichAll` (keys corpus tier/frequency/fix off
  the WCAG SC code alone), and the enforcement/contract gate.
- **New collector `collect-dom.ts`**: render a URL with **Playwright** (real
  Chromium, so axe sees layout → color-contrast / target-size / reflow / computed
  roles), run `axe-core`, map each result to a `Finding`. WCAG SC comes straight
  from axe `tags` (`wcag111` → `1.1.1`) — **no rule-id crosswalk needed**, because
  `enrichAll` enriches by SC, not by rule id.
- **Generalize `Finding` location**: `file:line` for source findings,
  `url + selector` for DOM findings. Add `provenance: 'axe'` beside
  `'jsx-a11y' | 'enforce'`.
- **Delivery**: add a `check_url` endpoint beside `check_a11y` in `cli.ts` /
  `mcp.ts`.

Render engine is **Playwright**. jsdom is rejected for the audit case because it
is blind to color-contrast and all layout-dependent rules. A "both, configurable"
(jsdom for fast dev checks, Playwright for audits) split is deferred, not chosen.

Accepted limit (not a gap to fix): the DOM path inherits the corpus's **SC-level**
value (tier / frequency / fix) but **not** the `enforce` pass's component-level
recall — a rendered DOM has no components or imports. In exchange it gains what
static JSX can never see: contrast, computed roles, real rendered text. The
collectors are complementary, not equal.

## Consequences

- Adds Playwright + a browser download as a dependency for the URL path.
- Unlocks auditing any live site — React or not — through the same corpus / WCAG /
  enforcement machinery, closing the 0/14 audit-coverage gap.
- Sets up a clean future extraction of the rules core into a package the b8e
  audit backend (which already renders and screenshots) can consume as a library.
- First commit (smallest real step): `provenance += 'axe'` → `collect-dom.ts`
  (Playwright render → `axe.run` → `Finding[]`) → reuse `enrichAll` as-is →
  `check_url`.
