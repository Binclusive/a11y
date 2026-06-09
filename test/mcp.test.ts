import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractBlock } from "../src/agents-block";
import { CONTRACT_FILE, init } from "../src/commands";
import { parseContract } from "../src/contract";
import type { DomScanResult } from "../src/collect-dom";
import { checkA11y, checkUrl, getA11yRules, learnA11yRule } from "../src/mcp";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

// `checkUrl` renders a live page via `scanUrl` (real browser). Mock that one
// seam so we can drive `toCheckFinding` with a synthetic axe finding and assert
// the EMITTED `fix` — no Playwright needed.
vi.mock("../src/collect-dom", () => ({
  scanUrl: vi.fn(),
}));
const { scanUrl } = await import("../src/collect-dom");
const mockScanUrl = vi.mocked(scanUrl);

describe("check_url handler: axe findings emit axe's rule fix, not the SC corpus fix", () => {
  afterEach(() => mockScanUrl.mockReset());

  it("emits axe's per-rule guidance for aria-progressbar-name, keeps the corpus tier", async () => {
    // `aria-progressbar-name` is tagged WCAG 1.1.1 — an SC the audit corpus HAS
    // (common, 16/26), whose generic fix is the image-alt fix. The emitted
    // `fix` must be axe's rule guidance, never that contradictory corpus fix.
    const result: DomScanResult = {
      url: "file:///page.html",
      findings: [
        {
          file: "file:///page.html",
          line: 0,
          selector: ".progress-bar",
          ruleId: "aria-progressbar-name",
          message: "ARIA progressbar nodes must have an accessible name",
          wcag: ["1.1.1"],
          enforcement: "block",
          provenance: "axe",
          severity: "serious",
          helpUrl:
            "https://dequeuniversity.com/rules/axe/4.11/aria-progressbar-name?application=axeAPI",
        },
      ],
    };
    mockScanUrl.mockResolvedValue(result);

    const r = await checkUrl("file:///page.html");
    const f = r.findings.find((x) => x.ruleId === "aria-progressbar-name");
    expect(f).toBeDefined();
    // Corpus SC-level frequency fact survives (the moat).
    expect(f?.source).toBe("audit");
    expect(f?.tier).toBe("common");
    expect(f?.wcag).toContain("1.1.1");
    // The EMITTED fix is axe's rule guidance, NOT the 1.1.1 image-alt corpus fix.
    expect(f?.fix).toBe("ARIA progressbar nodes must have an accessible name");
    expect(f?.fix).not.toMatch(/alt text/i);
    expect(f?.helpUrl).toContain("aria-progressbar-name");
  });
});

describe("check_a11y handler", () => {
  it("returns enriched findings + coverage for the fixture dir", async () => {
    const r = await checkA11y(FIXTURES);

    expect(r.filesScanned).toBeGreaterThan(0);
    expect(r.coverage.total).toBeGreaterThan(0);
    expect(r.findings.length).toBeGreaterThan(0);

    // The two fixture anchors-without-content are very-common 2.4.4 findings.
    const finding = r.findings.find((f) => f.ruleId === "jsx-a11y/anchor-has-content");
    expect(finding).toBeDefined();
    expect(finding?.wcag).toContain("2.4.4");
    expect(finding?.tier).toBe("very-common");
    expect(finding?.fix).not.toBeNull();
    // Paths are relativized to the scan root — no absolute leakage.
    expect(finding?.file.startsWith("/")).toBe(false);
  });

  it("returns empty findings (not an error) for a dir with no .tsx", async () => {
    const dir = await mkdtemp(join(tmpdir(), "a11y-mcp-empty-"));
    try {
      const r = await checkA11y(dir);
      expect(r.filesScanned).toBe(0);
      expect(r.findings).toEqual([]);
      expect(r.coverage.total).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("get_a11y_rules handler", () => {
  it("returns the top rules with no filter", () => {
    const r = getA11yRules({});
    expect(r.matchedOn).toBe("top");
    expect(r.patterns.length).toBeGreaterThan(0);
    expect(r.count).toBe(r.patterns.length);
  });

  it("filters by component substring (case-insensitive)", () => {
    const r = getA11yRules({ component: "link" });
    expect(r.matchedOn).toBe("component");
    expect(r.patterns.length).toBeGreaterThan(0);
    expect(r.patterns.every((p) => p.component.toLowerCase().includes("link"))).toBe(true);
  });

  it("filters by exact WCAG SC", () => {
    const r = getA11yRules({ sc: "2.4.4" });
    expect(r.matchedOn).toBe("sc");
    expect(r.patterns.length).toBeGreaterThan(0);
    expect(r.patterns.every((p) => p.sc === "2.4.4")).toBe(true);
  });

  it("component takes precedence over sc when both are given", () => {
    const r = getA11yRules({ component: "link", sc: "2.4.4" });
    expect(r.matchedOn).toBe("component");
  });

  it("backs an SC query with the baseline entry even when distilled (2.4.4)", () => {
    const r = getA11yRules({ sc: "2.4.4" });
    expect(r.baseline.length).toBeGreaterThan(0);
    expect(r.baseline.every((b) => b.sc.includes("2.4.4"))).toBe(true);
  });

  it("answers for an axe ruleId the corpus never distilled (color-contrast)", () => {
    const r = getA11yRules({ ruleId: "color-contrast" });
    expect(r.matchedOn).toBe("ruleId");
    expect(r.patterns).toEqual([]); // no distilled pattern for it
    const cc = r.baseline.find((b) => b.ruleId === "color-contrast");
    expect(cc?.severity).toBe("serious");
    expect(cc?.sc).toContain("1.4.3");
    expect(cc?.helpUrl).toContain("dequeuniversity.com");
  });

  it("falls back to baseline for an SC the corpus has not distilled (2.4.2)", () => {
    // 2.4.2 (page-title) has no distilled pattern — pure baseline coverage.
    const r = getA11yRules({ sc: "2.4.2" });
    expect(r.patterns).toEqual([]);
    expect(r.baseline.some((b) => b.ruleId === "document-title")).toBe(true);
  });
});

describe("learn_a11y_rule handler", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "a11y-mcp-learn-"));
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "fixture", dependencies: { next: "15", react: "18" } }),
    );
    await writeFile(join(dir, "tsconfig.json"), "{}");
    await init(dir); // learn requires an existing contract.
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("appends to learned[] and regenerates the managed block", async () => {
    const r = await learnA11yRule({
      rule: "Label icon-only buttons with aria-label",
      wcag: ["4.1.2"],
      fix: "Add aria-label",
      source: "review",
      dir,
    });

    expect(r.added).toBe(true);
    expect(r.id).toBe("label-icon-only-buttons-with-aria-label");
    expect(r.blockPaths.length).toBeGreaterThan(0);

    const onDisk = parseContract(JSON.parse(await readFile(join(dir, CONTRACT_FILE), "utf8")));
    expect(onDisk.learned).toHaveLength(1);
    expect(onDisk.learned[0]).toMatchObject({
      rule: "Label icon-only buttons with aria-label",
      wcag: ["4.1.2"],
      fix: "Add aria-label",
      source: "review",
    });

    const agents = await readFile(join(dir, "AGENTS.md"), "utf8");
    expect(extractBlock(agents)).not.toBeNull();
    expect(agents).toContain("Label icon-only buttons with aria-label");
  });

  it("defaults wcag/fix/source when omitted, and dedupes identical rules", async () => {
    const first = await learnA11yRule({ rule: "Custom rule", dir });
    expect(first.added).toBe(true);

    const onDisk = parseContract(JSON.parse(await readFile(join(dir, CONTRACT_FILE), "utf8")));
    expect(onDisk.learned[0]).toMatchObject({ wcag: [], fix: null, source: "mcp" });

    const dup = await learnA11yRule({ rule: "  CUSTOM   rule  ", dir });
    expect(dup.added).toBe(false);
  });
});
