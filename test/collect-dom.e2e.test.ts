/**
 * END-TO-END test for the rendered-DOM accessibility path.
 *
 * This is the ONLY test that exercises the real render → axe-core → `Finding`
 * pipeline (`scanUrl` in `src/collect-dom.ts`): it launches actual Chromium,
 * navigates to a self-contained `file://` fixture, runs axe against the rendered
 * DOM, and asserts the mapped findings. It is the regression guard for the whole
 * browser-coupled seam — e.g. the `browser.newContext()` requirement that no
 * unit test exercised, which slipped through to runtime before this existed.
 *
 * GATING — this file is EXCLUDED from the default `pnpm test` (unit) run via
 * `**\/*.e2e.test.ts` in vitest.config.ts, so the unit suite stays fast and
 * browser-free. Run it explicitly:
 *
 *     npx playwright install chromium   # CI must do this first
 *     pnpm test:e2e
 *
 * The assertions are intentionally presence-based (specific rule ids / SCs are
 * present, not exact totals) so an added axe rule or new best-practice flag does
 * not turn this red.
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanUrl } from "../src/collect-dom";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = pathToFileURL(join(here, "fixtures", "a11y-broken.html")).href;

// Browser launch + navigation + axe run takes several seconds cold; give it room.
const E2E_TIMEOUT_MS = 60_000;

describe("scanUrl: real render → axe → Finding pipeline (e2e, launches Chromium)", () => {
  it(
    "emits axe-provenance findings for the known violations in the file:// fixture",
    async () => {
      const { url, findings } = await scanUrl(FIXTURE);

      expect(url).toBe(FIXTURE);
      expect(findings.length).toBeGreaterThan(0);

      const ruleIds = new Set(findings.map((f) => f.ruleId));
      // The intentional, layout-independent violations in the fixture. Each must
      // surface — these are the deterministic core of the rendered-DOM path.
      expect(ruleIds).toContain("image-alt"); // <img> with no alt        → 1.1.1
      expect(ruleIds).toContain("label"); //     unlabeled <input>        → label/name
      expect(ruleIds).toContain("link-name"); // <a href> with no name    → 2.4.4 / 4.1.2
      expect(ruleIds).toContain("button-name"); // empty <button>          → 4.1.2

      // SC mapping must round-trip off axe tags through scFromTags.
      const scs = new Set(findings.flatMap((f) => f.wcag));
      expect(scs).toContain("1.1.1"); // image-alt
      expect(scs).toContain("2.4.4"); // link-name

      // Every finding from this path is the axe producer, anchored by a selector
      // (not a source line), and carries axe's runtime impact as severity.
      for (const f of findings) {
        expect(f.provenance).toBe("axe");
        expect(typeof f.selector).toBe("string");
        expect(f.selector!.length).toBeGreaterThan(0);
        expect(["minor", "moderate", "serious", "critical"]).toContain(f.severity);
      }

      // Spot-check the image-alt finding's shape end to end.
      const imageAlt = findings.find((f) => f.ruleId === "image-alt");
      expect(imageAlt).toBeDefined();
      expect(imageAlt!.file).toBe(FIXTURE);
      expect(imageAlt!.line).toBe(0);
      expect(imageAlt!.wcag).toContain("1.1.1");
    },
    E2E_TIMEOUT_MS,
  );
});
