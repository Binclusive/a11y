/**
 * The React / Next.js reasoning core — ported from the
 * `Binclusive-Accessibility-Skills` repo's `react-nextjs.md` audit checklist and
 * `patterns/react-nextjs-patterns.md` catalog (issue #2096). The prose is carried
 * over faithfully; only its FORMAT changed (loose markdown → typed data) so the
 * runner's AI lane can consult it with no external agent harness.
 *
 * React / TSX is the first framework wired (epic #2083); the other frameworks the
 * skills repo covers (React Native, iOS, Android, ASP.NET, Shopify) are parked.
 */
import type { FrameworkGuidance } from "./types";

export const REACT_GUIDANCE: FrameworkGuidance = {
  framework: "React / Next.js",
  appliesTo: "React or Next.js web projects (.tsx / .jsx source, jsx-a11y / enforce / axe findings).",
  checklist: [
    {
      title: "Framework-Specific Areas",
      items: [
        "Next.js App Router: audit `app/**/page.*`, `layout.*`, `template.*`, route groups, dynamic segments, loading/error/not-found files, and `[locale]` segments.",
        "Next.js Pages Router: audit `pages/**` except API routes; include `_app`, `_document`, and layout wrappers for lang, landmarks, providers, and page title behavior.",
        "React Router/Vite: audit route config, `<Routes>`, lazy route boundaries, layout components, and SPA route focus management.",
      ],
    },
    {
      title: "High-Risk React Patterns",
      items: [
        "non-semantic click targets: `div/span` with `onClick`",
        "icon-only buttons without accessible names",
        "custom controls without role/name/state and keyboard support",
        "modals/drawers/popovers without focus management and accessible name",
        "forms missing label/id pairing, error association, required/autocomplete signals",
        "table components that render data with `<div>` grids, `<td>` headers, missing `<caption>`, missing `<th scope>`, or lost header relationships after responsive rendering",
        "route changes without focus reset or announcement",
        "hardcoded `aria-label`, `placeholder`, `title`, `alt`, and visible strings outside i18n",
        "animation without reduced-motion handling",
        "Suspense/loading/toast states without live region strategy",
      ],
    },
    {
      title: "React / Next.js Table Checks",
      items: [
        "Audit reusable table/data-grid components and inline `<table>` markup for a programmatic table name: prefer a visible `<caption>` for data tables, or use `aria-labelledby`/`aria-label` when the design intentionally has no visible caption.",
        "Verify header cells are rendered as `<th>`, not styled `<td>`, `<div>`, or text-only wrappers.",
        "For simple tables, verify column headers use `scope=\"col\"` and row headers use `scope=\"row\"` when applicable.",
        "For grouped or multi-level headers, verify stable `id`/`headers` relationships or mark as `RUNTIME-CHECK` if the rendered structure cannot be proven statically.",
        "Check component APIs such as `columns`, `header`, `accessor`, `renderHeader`, and `cell` so icon-only or custom header renderers still expose meaningful header text.",
        "For sortable headers, verify a native `<button>` or equivalent keyboard support is used and the active sort state is exposed with `aria-sort` on the relevant header.",
        "Check responsive table/card transforms, virtualization, sticky headers, and horizontal scroll wrappers for lost header relationships, clipped focus, or runtime-only keyboard/reader behavior.",
        "Do not flag tables used purely for layout if they are hidden from table semantics with an appropriate presentation strategy; do flag layout tables exposed as data tables.",
      ],
    },
    {
      title: "Next.js Checks",
      items: [
        "`<html lang>` and locale-specific `dir` handling in root layout or document",
        "page titles and metadata per route",
        "skip-to-content link and stable `<main id=\"main-content\">`",
        "server/client component boundaries that hide interactive behavior in client wrappers",
        "image `alt` for `next/image`; decorative images use empty alt",
        "Link usage: navigational links must have href and meaningful text",
      ],
    },
    {
      title: "Runtime-Only Checks",
      items: [
        "Mark as `RUNTIME-CHECK` when not statically provable:",
        "color contrast and dark mode contrast",
        "focus trap/restore inside third-party dialogs",
        "actual screen-reader announcement order",
        "browser zoom/reflow at 200%/400%",
        "touch target measurements",
        "route transition focus behavior",
        "carousel autoplay pause behavior",
        "responsive or virtualized table header relationships",
      ],
    },
  ],
  patterns: [
    {
      id: "PATTERN-REACT-001",
      title: "Non-semantic click target",
      componentType: "Button-like custom control",
      wcag: ["2.1.1", "4.1.2"],
      severityDefault: "Critical",
      fixTypeDefault: "FUNCTIONAL-RISK",
      badShape: "A `div`, `span`, layout component, or icon wrapper has `onClick` but no native semantics.",
      detectionHints:
        "`onClick` on non-interactive JSX elements; missing `role`, `tabIndex`, Enter/Space handler, and accessible name.",
      correctFix:
        "Render a native `<button type=\"button\">` for actions or `<a href>` for navigation. Use ARIA only when native replacement is not feasible.",
      verification: "Tab reaches it, Enter/Space activates it, and screen reader announces name, role, and state.",
      exceptions:
        "Do not flag non-interactive containers where the handler is only delegated and an inner native control handles activation.",
    },
    {
      id: "PATTERN-REACT-002",
      title: "Icon-only control without accessible name",
      componentType: "IconButton / close button / carousel arrow / menu trigger",
      wcag: ["4.1.2"],
      severityDefault: "Serious",
      fixTypeDefault: "SAFE",
      fixTypeNote: "SAFE when adding a real label; FUNCTIONAL-RISK when changing structure.",
      badShape:
        "A button or clickable icon contains only SVG/icon content and has no visible text, `aria-label`, or `aria-labelledby`.",
      detectionHints: "icon children, empty text content, close/search/favorite/menu SVGs.",
      correctFix:
        "Provide a localized accessible name that describes the action, not the icon. Hide decorative SVGs from assistive tech.",
      verification: "Screen reader announces the intended action plus role.",
      exceptions:
        "Do not add `aria-label` that conflicts with visible text; prefer visible text or `aria-labelledby` when available.",
    },
    {
      id: "PATTERN-REACT-003",
      title: "Form field label is visual only",
      componentType: "Input / Textarea / Select",
      wcag: ["1.3.1", "3.3.2"],
      severityDefault: "Serious",
      fixTypeDefault: "SAFE",
      badShape:
        "Visible label text is not programmatically associated with the form control, or placeholder is the only label.",
      detectionHints: "`<label>` without `htmlFor`, input without `id`, custom label wrapper, placeholder-only fields.",
      correctFix:
        "Use a stable `id` plus `<label htmlFor>`, or `aria-labelledby`; associate help/error text with `aria-describedby`.",
      verification: "Accessibility tree exposes the intended name and description.",
      exceptions:
        "A control can be validly named by `aria-label` or `aria-labelledby` when no visible label is appropriate.",
    },
    {
      id: "PATTERN-REACT-004",
      title: "Data table lacks semantic headers or caption",
      componentType: "Table / Data grid",
      wcag: ["1.3.1", "2.4.6"],
      severityDefault: "Serious",
      fixTypeDefault: "SAFE",
      fixTypeNote: "SAFE when adding caption/header semantics; RUNTIME-CHECK for virtualized or third-party grids.",
      badShape:
        "A data table renders without `<caption>`, uses `<td>` for headers, omits `scope`/`headers`, or renders a visual table with `<div>` elements and no equivalent grid semantics.",
      detectionHints:
        "reusable `Table`, `DataTable`, `Grid`, `columns` configs, `renderHeader`, sortable headers, `<table>` without `<caption>`, `<thead>` containing `<td>`.",
      correctFix:
        "Use native table markup for tabular data; provide a table name, semantic `<th>` headers, `scope` for simple relationships, and `id`/`headers` for complex relationships.",
      verification:
        "Screen reader can identify the table name and announce the correct row/column headers for representative cells.",
      exceptions:
        "Do not require `<caption>` for layout tables that are correctly removed from table semantics; do not force native tables for interactive widgets that correctly implement the ARIA grid pattern.",
    },
  ],
};
