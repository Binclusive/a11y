import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFindingPayload } from "@binclusive/a11y-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractBlock } from "../src/agents-block";
import { CONTRACT_FILE, init } from "../src/commands";
import { parseContract } from "../src/contract";
import type { DomScanResult } from "../src/collect-dom";
import { checkA11y, checkUnity, checkUrl, getA11yRules, learnA11yRule } from "../src/mcp";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

// `checkUrl` renders a live page via `scanUrl` (real browser). Mock that one
// seam so we can drive the emit projection with a synthetic axe finding and
// assert the canonical contract shape — no Playwright needed.
vi.mock("../src/collect-dom", () => ({
  scanUrl: vi.fn(),
}));
const { scanUrl } = await import("../src/collect-dom");
const mockScanUrl = vi.mocked(scanUrl);

describe("check_url handler: emits the canonical @binclusive/a11y-contract payload", () => {
  afterEach(() => mockScanUrl.mockReset());

  const axeResult: DomScanResult = {
    url: "https://example.com/page",
    status: "ok",
    findings: [
      {
        file: "https://example.com/page",
        line: 0,
        selector: ".progress-bar",
        ruleId: "aria-progressbar-name",
        message: "ARIA progressbar nodes must have an accessible name",
        wcag: ["1.1.1"],
        enforcement: "block",
        provenance: "axe",
        impact: "serious",
        helpUrl:
          "https://dequeuniversity.com/rules/axe/4.11/aria-progressbar-name?application=axeAPI",
      },
    ],
  };

  it("returns a contract FindingPayload, not the MCP-local CheckFinding DTO", async () => {
    mockScanUrl.mockResolvedValue(axeResult);

    const payload = await checkUrl("https://example.com/page");

    // The returned value is the canonical wire payload — it re-parses through the
    // contract's own schema (proves the shape, incl. the .strict() no-extra-keys moat).
    expect(() => parseFindingPayload(payload)).not.toThrow();

    const f = payload.findings.find((x) => x.element === ".progress-bar");
    expect(f).toBeDefined();
    // Rendered-DOM findings are deterministic and page-located.
    expect(f?.provenance).toBe("deterministic");
    expect(f?.location).toEqual({ kind: "page", url: "https://example.com/page" });
    // WCAG SC, evidence, and scope come straight off the enriched finding.
    expect(f?.criterion).toBe("1.1.1");
    expect(f?.evidence).toBe("ARIA progressbar nodes must have an accessible name");
    expect(f?.scope).toBe("https://example.com/page");

    // The MCP-local DTO fields are GONE — the surface no longer leaks source
    // locators or the flat `ruleId`/`fix`/`helpUrl`/`wcag` shape (#216).
    for (const key of ["ruleId", "fix", "helpUrl", "wcag", "source", "file", "line", "impact"]) {
      expect(f).not.toHaveProperty(key);
    }
  });

  it("re-throws on a failed render (fail-loud, never a silent clean pass — #218)", async () => {
    mockScanUrl.mockResolvedValue({
      url: "https://example.com/page",
      status: "failed",
      error: "Failed to load https://example.com/page: net::ERR_FAILED",
    });

    await expect(checkUrl("https://example.com/page")).rejects.toThrow(/Failed to load/);
  });
});

describe("check_a11y handler", () => {
  it("returns enriched findings + coverage for the fixture dir", async () => {
    const r = await checkA11y(FIXTURES);

    expect(r.filesScanned).toBeGreaterThan(0);
    expect(r.coverage.total).toBeGreaterThan(0);
    expect(r.findings.length).toBeGreaterThan(0);

    // The two fixture anchors-without-content are 2.4.4 findings.
    const finding = r.findings.find((f) => f.ruleId === "jsx-a11y/anchor-has-content");
    expect(finding).toBeDefined();
    expect(finding?.wcag).toContain("2.4.4");
    expect(finding?.source).toBe("baseline");
    expect(finding).not.toHaveProperty("tier");
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

describe("check_unity handler", () => {
  const UNITY_PROJECT = join(FIXTURES, "unity-project");

  it("returns enriched Unity findings for a project dir, mirroring check_a11y", async () => {
    const r = await checkUnity(UNITY_PROJECT);

    // The fixture yields the aggregator's full finding stream (6 findings: 3
    // color-only, 1 missing-label, 2 project-level baseline) — see unity-findings.test.ts.
    expect(r.findings.length).toBeGreaterThan(0);
    expect(r.root).toBe(UNITY_PROJECT);

    // Every finding is a Unity finding (baseline enrichment, parity with .tsx).
    for (const f of r.findings) {
      expect(f.provenance).toBe("unity");
    }

    // The missing-accessible-label finding is present and WCAG-bridged.
    const missing = r.findings.find((f) => f.ruleId === "unity/missing-accessible-label");
    expect(missing).toBeDefined();
    expect(missing?.wcag).toEqual(["1.1.1", "4.1.2"]);

    // Paths are relativized to the project root — no absolute leakage (parity with check_a11y).
    for (const f of r.findings) {
      expect(f.file.startsWith("/")).toBe(false);
    }
    expect(r.findings.some((f) => f.file === "ButtonNoLabel.prefab")).toBe(true);
  });

  it("does not error on a dir with no .prefab/.unity assets (no per-widget findings)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "a11y-mcp-unity-empty-"));
    try {
      const r = await checkUnity(dir);
      expect(r.root).toBe(resolve(dir));
      // No assets ⇒ no per-widget findings (color-only / missing-label). The
      // project-level baseline rules (no-screen-reader-support / no-input-rebinding)
      // are absence-based, so they still fire — that is the aggregator's contract,
      // surfaced unchanged through the MCP tool (no Unity-specific filtering here).
      expect(r.findings.some((f) => f.ruleId === "unity/missing-accessible-label")).toBe(false);
      expect(r.findings.some((f) => f.ruleId === "unity/color-only-state")).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("get_a11y_rules handler (axe baseline catalog — ADR 0041 §G, no corpus)", () => {
  it("returns the top rules with no filter", () => {
    const r = getA11yRules({});
    expect(r.matchedOn).toBe("top");
    expect(r.baseline.length).toBeGreaterThan(0);
    expect(r.count).toBe(r.baseline.length);
  });

  it("filters by component substring, mapped to an axe ruleId (case-insensitive)", () => {
    const r = getA11yRules({ component: "image" });
    expect(r.matchedOn).toBe("component");
    expect(r.baseline.length).toBeGreaterThan(0);
    expect(r.baseline.every((b) => b.ruleId.toLowerCase().includes("image"))).toBe(true);
  });

  it("filters by exact WCAG SC", () => {
    const r = getA11yRules({ sc: "2.4.4" });
    expect(r.matchedOn).toBe("sc");
    expect(r.baseline.length).toBeGreaterThan(0);
    expect(r.baseline.every((b) => b.sc.includes("2.4.4"))).toBe(true);
  });

  it("component takes precedence over sc when both are given", () => {
    const r = getA11yRules({ component: "image", sc: "2.4.4" });
    expect(r.matchedOn).toBe("component");
  });

  it("answers for an axe ruleId (color-contrast)", () => {
    const r = getA11yRules({ ruleId: "color-contrast" });
    expect(r.matchedOn).toBe("ruleId");
    const cc = r.baseline.find((b) => b.ruleId === "color-contrast");
    expect(cc?.impact).toBe("serious");
    expect(cc?.sc).toContain("1.4.3");
    expect(cc?.helpUrl).toContain("dequeuniversity.com");
  });

  it("answers by SC from the baseline catalog (2.4.2 page-title)", () => {
    const r = getA11yRules({ sc: "2.4.2" });
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

