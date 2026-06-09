/**
 * The rendered-DOM collector: the live-URL counterpart to `collect.ts` + the
 * `scan` in `core.ts`. Where that path needs `.tsx` on disk and reads a JSX AST,
 * this one renders a URL in a real browser and runs axe-core against the
 * resulting DOM — so it covers the ~half of real audited sites that are NOT
 * React (ASP.NET/Razor, server-rendered, jQuery) AND the React ones we only
 * have a live URL for, never the source.
 *
 * It is deliberately a SECOND PRODUCER into the same `Finding` shape, not a
 * second product: the findings it emits flow through the exact same SC-keyed
 * `enrichAll` corpus cross-ref and enforcement gate as the source passes. The
 * only bridge needed is reading the WCAG SC off axe's `tags` (`wcag111` →
 * `1.1.1`) — no rule-id crosswalk, because the corpus enriches by SC.
 *
 * Render engine is Playwright (real Chromium) by decision 0001: a real layout
 * is what lets axe run color-contrast / target-size / reflow and resolve
 * computed ARIA roles — exactly the categories a headless DOM (jsdom) is blind
 * to, and a huge share of real WCAG failures.
 */

import { AxeBuilder } from "@axe-core/playwright";
import { chromium } from "playwright";
import { enforcementFor } from "./config-scan";
import type { Finding } from "./core";
import { scFromTags } from "./wcag-tags";

// Re-exported so the historical `import { scFromTags } from "./collect-dom"`
// keeps working; the implementation now lives in the browser-free `wcag-tags.ts`
// so the offline baseline generator can share it without pulling in playwright.
export { scFromTags };

/** The result of rendering one URL and running axe over it. */
export interface DomScanResult {
  readonly url: string;
  readonly findings: readonly Finding[];
}

/** Options for {@link scanUrl}. */
export interface DomScanOptions {
  /** Max ms to wait for navigation + the `load` event. Default 30_000. */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Flatten an axe node target into a single CSS selector string. axe reports
 * `target` as an array — one entry per frame for cross-frame nodes — so we join
 * with the iframe-descent ` >>> ` marker axe itself uses. Nested arrays (shadow
 * DOM) are flattened the same way.
 */
function selectorOf(target: readonly unknown[]): string {
  return target.flat(Infinity).map(String).join(" >>> ");
}

/**
 * Render `url` in a real browser and return its accessibility findings as
 * `Finding[]` — the same shape the source passes emit, so callers run the
 * identical `enrichAll` + report path. Each axe violation expands to one finding
 * per offending node (so the report points at the actual elements). WCAG SC is
 * read from the violation's tags; enforcement is the zero-config default
 * (`block`) since a live URL has no `binclusive.json`.
 *
 * The browser is always closed, even on error. The caller owns the URL's
 * trustworthiness — this navigates to and executes whatever the page serves.
 */
export async function scanUrl(url: string, opts: DomScanOptions = {}): Promise<DomScanResult> {
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const browser = await chromium.launch();
  try {
    // @axe-core/playwright 4.11.x rejects pages from the implicit default
    // context — it requires an explicit browser.newContext().
    const context = await browser.newContext();
    const page = await context.newPage();
    // A typo'd or unreachable URL (or a nav timeout) rejects raw inside goto;
    // re-throw it as an actionable Error that names the URL, the cause, and the
    // most common real-world fix (pointing at a running server, not a raw
    // template file). The caller prints just this message — no stack.
    try {
      await page.goto(url, { waitUntil: "load", timeout });
    } catch (cause) {
      // Playwright's message embeds a multi-line "Call log:" block; keep only the
      // first line so the actionable Error reads as one clean line, not a dump.
      const raw = cause instanceof Error ? cause.message : String(cause);
      const reason = raw.split("\n")[0];
      throw new Error(
        `Failed to load ${url}: ${reason}. Check the URL is reachable; server-side templates (.cshtml etc.) only render via a running server — point check-url at localhost.`,
      );
    }
    const results = await new AxeBuilder({ page }).analyze();

    const findings: Finding[] = [];
    for (const v of results.violations) {
      const wcag = scFromTags(v.tags);
      const enforcement = enforcementFor(wcag, null);
      for (const node of v.nodes) {
        // axe's runtime IMPACT is the most accurate severity: it is computed
        // against the actual rendered node. Prefer the per-node impact; fall
        // back to the violation-level impact when axe leaves the node's null.
        const severity = node.impact ?? v.impact ?? undefined;
        findings.push({
          file: url,
          line: 0,
          selector: selectorOf(node.target),
          ruleId: v.id,
          message: v.help,
          wcag,
          enforcement,
          provenance: "axe",
          ...(severity != null ? { severity } : {}),
          helpUrl: v.helpUrl,
        });
      }
    }
    return { url, findings };
  } finally {
    await browser.close();
  }
}
