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
 * Read WCAG success criteria off axe-core's `tags`. axe tags an SC as
 * `wcag<principle><guideline><criterion>` with the dots removed — `wcag111` is
 * 1.1.1, `wcag244` is 2.4.4, `wcag1411` is 1.4.11. The principle and guideline
 * are always one digit; the criterion is the remainder (so 2-or-more-digit
 * criteria like `.11` round-trip). Conformance-level tags (`wcag2a`, `wcag21aa`)
 * and non-WCAG tags (`best-practice`, `cat.color`, `ACT`) carry letters and are
 * skipped. Deduped, original order preserved.
 *
 * This is the whole bridge between axe's vocabulary and the corpus: every
 * `enrichAll` lookup keys off these SC strings.
 */
export function scFromTags(tags: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tag of tags) {
    const m = /^wcag(\d)(\d)(\d+)$/.exec(tag);
    if (m === null) continue;
    const sc = `${m[1]}.${m[2]}.${m[3]}`;
    if (seen.has(sc)) continue;
    seen.add(sc);
    out.push(sc);
  }
  return out;
}

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
    await page.goto(url, { waitUntil: "load", timeout });
    const results = await new AxeBuilder({ page }).analyze();

    const findings: Finding[] = [];
    for (const v of results.violations) {
      const wcag = scFromTags(v.tags);
      const enforcement = enforcementFor(wcag, null);
      for (const node of v.nodes) {
        findings.push({
          file: url,
          line: 0,
          selector: selectorOf(node.target),
          ruleId: v.id,
          message: v.help,
          wcag,
          enforcement,
          provenance: "axe",
        });
      }
    }
    return { url, findings };
  } finally {
    await browser.close();
  }
}
