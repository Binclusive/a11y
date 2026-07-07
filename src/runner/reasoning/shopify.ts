/**
 * The Shopify (Liquid theme) reasoning core — ported from the
 * `Binclusive-Accessibility-Skills` repo's `shopify-theme-audit` skill:
 * the `references/shopify-theme-a11y.md` audit reference (theme-structure
 * signals, high-risk patterns, per-surface checks, severity + fix-type guidance)
 * and its `SKILL.md` audit order (issue #2319). The prose is carried over
 * faithfully; only its FORMAT changed (loose markdown → typed data) so the
 * runner's AI lane can consult it with no external agent harness.
 *
 * The skills repo ships no dedicated `patterns/shopify-*.md` catalog, so the seed
 * patterns below are drawn from the reference's own "High-Risk Shopify Patterns"
 * and per-surface checks; each pattern's WCAG SC reuses the mapping the skills
 * repo already assigned to the identical web patterns in
 * `patterns/react-nextjs-patterns.md` (same failure, same SC).
 *
 * Shopify is the second framework wired; React / TSX was the first (epic #2083).
 * The remaining frameworks the skills repo covers (React Native, iOS, Android,
 * ASP.NET, Angular, Flutter) are parked.
 */
import type { FrameworkGuidance } from "./types";

export const SHOPIFY_GUIDANCE: FrameworkGuidance = {
  framework: "Shopify (Liquid theme)",
  appliesTo:
    "Shopify Online Store themes — Liquid layouts/templates/sections/snippets, JSON templates, theme assets/config/locales (`.liquid` source, `liquid` findings).",
  checklist: [
    {
      title: "Theme Structure Signals",
      items: [
        "`layout/*.liquid`: global HTML shell, skip links, main content, global messages, SEO/title, locale direction, app embeds.",
        "`templates/*.json` and `templates/*.liquid`: page composition, section ordering, setting values, customer/cart/product/collection/search/blog/password/404 pages.",
        "`sections/*.liquid`: Online Store 2.0 sections, schema settings, block rendering, merchant-configurable headings, links, media, color schemes, and behavior flags.",
        "`snippets/*.liquid`: shared controls and markup fragments.",
        "`assets/*.{js,css,liquid}`: custom elements, focus management, keyboard support, dynamic rendering, live regions, focus styles, visually hidden utilities, reduced motion, responsive behavior.",
        "`config/settings_schema.json` and `config/settings_data.json`: theme settings that affect colors, headings, social links, checkout/cart behavior, image behavior, labels, and optional features.",
        "`locales/*.json`: visible strings, aria labels, hidden text, status messages, new-window warnings, error messages, and translation completeness.",
        "`blocks/`, `customers/`, or app extension files when present.",
      ],
    },
    {
      title: "High-Risk Shopify Patterns",
      items: [
        "CTA links rendered as `<a>` without `href`, or with `role=\"link\" aria-disabled=\"true\"` as a published-state fallback.",
        "Icon-only cart, search, account, menu, close, quantity, filter, sort, carousel, media, or social controls without localized accessible names.",
        "Merchant-configurable image, slideshow, banner, collection, and product media that may lose meaning when alt text or nearby text is empty.",
        "Product cards with duplicate links, inaccessible quick-add buttons, sale/badge text communicated only visually, or hidden product metadata that changes the accessible name.",
        "Variant pickers, quantity selectors, recipient forms, cart notes, discount fields, and contact/newsletter forms without labels, error association, required state, or autocomplete.",
        "Facets/filters/sort controls that update result counts without a status/live region or lose focus after AJAX updates.",
        "Drawers, modals, predictive search, cart notifications, localization popovers, media modals, pickup availability dialogs, and quick-add flows without focus move, trap, Escape close, and focus restore.",
        "Sliders/carousels without pause control, keyboard-operable controls, reduced-motion handling, or accessible slide names.",
        "Native `<details>/<summary>` patterns over-customized with roles, click delegation, or state that diverges from the native open state.",
        "Tooltip/help content available only on pointer hover or hidden with `aria-hidden` while carrying meaningful information.",
        "CSS utilities such as `.focus-none`, `[hidden]`, `display: none`, `visibility: hidden`, opacity-only hiding, or offscreen techniques that remove focus visibility or expose hidden content incorrectly.",
        "Dynamic HTML replacement that does not preserve focus, update status text, or reinitialize accessible behavior after cart/filter/search changes.",
        "App embeds, remote scripts, reviews, subscriptions, chat, loyalty, cookie banners, and personalization widgets that render inaccessible controls outside the theme source.",
      ],
    },
    {
      title: "Layout and Global Shell",
      items: [
        "Verify a skip link exists and targets a real main container.",
        "Verify one clear `<main>` landmark is present and repeated header/footer/navigation regions are not nested incorrectly.",
        "Verify `<html lang>` and `dir` or locale direction are set when the theme supports multiple languages or RTL locales.",
        "Verify global accessibility helper strings exist in locale files and are used for hidden messages such as refresh/new-window notices.",
        "Check app embed placeholders and third-party script outputs as blind spots when source is unavailable.",
      ],
    },
    {
      title: "Templates, Sections, and Blocks",
      items: [
        "Read JSON templates with the Liquid section files they reference.",
        "Treat `settings` and `blocks` as part of the audit evidence: empty link, heading, image, label, or accessibility text settings can change the result.",
        "Verify section schema defaults do not encourage inaccessible published states.",
        "Check heading level choices for hero/banner/slideshow sections. Mark content architecture concerns as `RUNTIME-CHECK` when final merchant composition determines the issue.",
        "Verify optional buttons are not rendered as disabled fake links when a URL setting is blank.",
      ],
    },
    {
      title: "Links, Buttons, and Controls",
      items: [
        "Prefer real `<button type=\"button\">` for actions and real `<a href>` for navigation.",
        "Flag non-semantic clickable elements and anchors used as buttons.",
        "Verify custom controls expose name, role, state, focusability, and Enter/Space behavior.",
        "Check quantity, variant, filter, sort, and carousel controls for visible labels or localized accessible names.",
      ],
    },
    {
      title: "Forms",
      items: [
        "Verify labels are programmatically associated with inputs, textareas, selects, checkboxes, and radios.",
        "Verify error messages connect with `aria-describedby` and invalid state uses `aria-invalid` where applicable.",
        "Verify required fields, autocomplete tokens, fieldsets/legends, and success/error live regions for customer, newsletter, contact, gift card, cart note, and recipient forms.",
      ],
    },
    {
      title: "Dynamic UI",
      items: [
        "Verify predictive search, cart drawer, quick add, filters, localization selectors, media modals, popovers, and drawers manage focus.",
        "Verify dynamic updates use `role=\"status\"`, `aria-live`, or an equivalent announcement strategy.",
        "Verify `aria-expanded`, `aria-controls`, selected/current states, and disabled states are synchronized with rendered state.",
        "Mark minified or remote behavior as `RUNTIME-CHECK` when static source cannot prove it.",
      ],
    },
    {
      title: "Media and Visual Content",
      items: [
        "Verify informative images have meaningful alt text or nearby text that carries the same meaning.",
        "Verify decorative images and icons are hidden from assistive technology.",
        "Treat hero/banner/slideshow alt text as content-governance risk when merchant content determines whether the image is informative.",
        "Verify video, model viewers, external embeds, and media galleries have accessible controls, captions/transcripts when relevant, and keyboard support.",
      ],
    },
    {
      title: "CSS, Motion, and Visual States",
      items: [
        "Verify focus is visible on interactive controls across theme color schemes.",
        "Flag utilities that remove outline/box-shadow on focus when used on interactive elements.",
        "Verify reduced-motion support for animations, drawers, sliders, carousels, parallax, and transitions.",
        "Verify forced-colors/high-contrast support where CSS custom properties or box shadows carry essential state.",
        "Mark contrast, zoom/reflow, and touch target measurements as `RUNTIME-CHECK` unless directly measured in a running storefront.",
      ],
    },
  ],
  patterns: [
    {
      id: "PATTERN-SHOPIFY-001",
      title: "CTA link rendered as a disabled fake link",
      componentType: "CTA link / button (section or block)",
      wcag: ["2.1.1", "4.1.2"],
      severityDefault: "Critical",
      fixTypeDefault: "FUNCTIONAL-RISK",
      badShape:
        "A CTA is rendered as `<a>` without `href`, or with `role=\"link\" aria-disabled=\"true\"` as a published-state fallback, typically when a merchant URL setting is blank.",
      detectionHints:
        "`<a>` without `href` in a section/snippet, `aria-disabled=\"true\"` on an anchor, buttons rendered as disabled fake links when a URL setting is empty.",
      correctFix:
        "Prefer a real `<button type=\"button\">` for actions and a real `<a href>` for navigation; do not render optional buttons as disabled fake links when a URL setting is blank.",
      verification:
        "Tab reaches the control, it activates with Enter/Space (or navigates via a real href), and a screen reader announces its name and role.",
      exceptions:
        "Do not flag a genuinely omitted control; when a URL setting is blank the accessible resolution is to not render the control, not to render a disabled fake link.",
    },
    {
      id: "PATTERN-SHOPIFY-002",
      title: "Icon-only store control without localized accessible name",
      componentType: "Icon-only cart / search / account / menu / close / filter / sort / carousel control",
      wcag: ["4.1.2"],
      severityDefault: "Serious",
      fixTypeDefault: "SAFE",
      badShape:
        "An icon-only cart, search, account, menu, close, quantity, filter, sort, carousel, media, or social control has no localized accessible name.",
      detectionHints:
        "icon/SVG-only controls in header/snippet markup, empty text content, missing `aria-label`/locale-backed hidden text on cart/search/account/menu/close SVGs.",
      correctFix:
        "Provide a localized accessible name that describes the action, sourced from locale strings; hide decorative SVG/icon content from assistive technology.",
      verification: "Screen reader announces the intended action plus role.",
      exceptions:
        "Do not recommend placeholder names such as `button`, `image`, `icon`, or `link`, or untranslated English labels in a localized theme.",
    },
    {
      id: "PATTERN-SHOPIFY-003",
      title: "Store form control without associated label or error state",
      componentType: "Variant picker / quantity selector / newsletter / contact / cart-note form control",
      wcag: ["1.3.1", "3.3.2"],
      severityDefault: "Serious",
      fixTypeDefault: "SAFE",
      badShape:
        "Variant pickers, quantity selectors, recipient forms, cart notes, discount fields, and contact/newsletter forms lack labels, error association, required state, or autocomplete.",
      detectionHints:
        "inputs/textareas/selects/checkboxes/radios without associated labels, missing `aria-describedby` for errors, missing `aria-invalid`, missing required/autocomplete tokens in customer/newsletter/contact/gift-card/cart-note forms.",
      correctFix:
        "Programmatically associate labels with each control; connect error messages with `aria-describedby` and set invalid state with `aria-invalid`; provide required fields, autocomplete tokens, fieldsets/legends, and success/error live regions.",
      verification: "Accessibility tree exposes the intended name, description, required, and invalid state for each control.",
      exceptions:
        "A control can be validly named by `aria-label` or `aria-labelledby` when no visible label is appropriate.",
    },
    {
      id: "PATTERN-SHOPIFY-004",
      title: "Drawer or modal without focus management",
      componentType: "Cart drawer / predictive search / quick-add / media modal / localization popover",
      wcag: ["2.4.3", "4.1.2"],
      severityDefault: "Serious",
      fixTypeDefault: "FUNCTIONAL-RISK",
      badShape:
        "Drawers, modals, predictive search, cart notifications, localization popovers, media modals, pickup availability dialogs, and quick-add flows open without focus move, trap, Escape close, and focus restore.",
      detectionHints:
        "custom drawer/modal elements in assets/snippets, missing focus move on open, no Escape handler, no focus restore on close, missing `role=\"dialog\"`/`aria-modal`/`aria-labelledby`.",
      correctFix:
        "Move focus into the dialog on open, trap focus while open, close on Escape, and restore focus to the trigger on close; expose `role=\"dialog\"`, `aria-modal`, and an accessible name.",
      verification:
        "Keyboard focus enters the dialog on open, cannot leave it while open, Escape closes it, and focus returns to the trigger. Mark as `RUNTIME-CHECK` when behavior lives in minified/third-party scripts.",
      exceptions:
        "Do not flag native `<details>/<summary>` disclosure that is not over-customized; mark focus trap/restore as `RUNTIME-CHECK` when it cannot be proven from static source.",
    },
    {
      id: "PATTERN-SHOPIFY-005",
      title: "AJAX facet/cart update without status region or focus preservation",
      componentType: "Facets / filters / sort / cart / predictive-search dynamic update",
      wcag: ["4.1.3"],
      severityDefault: "Serious",
      fixTypeDefault: "FUNCTIONAL-RISK",
      badShape:
        "Facets/filters/sort controls update result counts, or dynamic HTML replacement re-renders cart/filter/search regions, without a status/live region, preserved focus, or reinitialized accessible behavior.",
      detectionHints:
        "AJAX section rendering / `fetch` replacing markup in assets, no `role=\"status\"`/`aria-live` region for updated counts, focus lost after re-render, behavior not reinitialized after cart/filter/search changes.",
      correctFix:
        "Announce dynamic updates with `role=\"status\"`, `aria-live`, or an equivalent strategy; preserve or move focus deliberately after the update; reinitialize accessible behavior on the replaced markup.",
      verification:
        "A screen reader announces the updated result/cart state and focus lands on a sensible element after the update. Mark as `RUNTIME-CHECK` when the behavior is minified or remote.",
      exceptions:
        "Mark minified or remote (app embed / third-party) behavior as `RUNTIME-CHECK` when static source cannot prove the announcement or focus handling.",
    },
  ],
};
