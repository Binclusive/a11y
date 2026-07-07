import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { collectLiquidFiles, scanLiquid } from "../src/collect-liquid";
import { buildJsonReport } from "../src/cli";
import { enrichAll } from "../src/evidence";

/**
 * Coverage for the Liquid collector boundary (L3). Drives the in-process parse +
 * structural-absence rules over a fixture theme: violations are caught in
 * `bad.liquid`, none in `good.liquid`, a malformed file is skipped (not fatal),
 * and the `--json` report shape matches `check`. No browser, no network.
 */

const here = dirname(fileURLToPath(import.meta.url));
const themeDir = join(here, "fixtures", "liquid-theme");

const ruleIdsIn = (file: string, findings: readonly { ruleId: string; file: string }[]) =>
  findings.filter((f) => f.file.endsWith(file)).map((f) => f.ruleId);

describe("collectLiquidFiles: the walk", () => {
  it("collects every .liquid file under the theme, descending into subdirs", async () => {
    const files = await collectLiquidFiles(themeDir);
    expect(files).toHaveLength(3);
    expect(files.every((f) => f.endsWith(".liquid"))).toBe(true);
  });

  it("returns [] for a missing/unreadable directory instead of throwing", async () => {
    await expect(collectLiquidFiles(join(themeDir, "does-not-exist"))).resolves.toEqual([]);
  });
});

describe("scanLiquid: findings", () => {
  it("finds the structural violations in bad.liquid", async () => {
    const { findings } = await scanLiquid(themeDir);
    const bad = ruleIdsIn("bad.liquid", findings);
    expect(bad).toContain("liquid/img-no-alt");
    expect(bad).toContain("liquid/control-no-name");
    expect(bad).toContain("liquid/iframe-no-title");
  });

  it("reports nothing for good.liquid (all controls have accessible names)", async () => {
    const { findings } = await scanLiquid(themeDir);
    expect(ruleIdsIn("good.liquid", findings)).toEqual([]);
  });

  it("every finding carries provenance 'liquid' and a contract-derived enforcement", async () => {
    const { findings } = await scanLiquid(themeDir);
    expect(findings.length).toBeGreaterThan(0);
    for (const f of findings) {
      expect(f.provenance).toBe("liquid");
      expect(["block", "warn"]).toContain(f.enforcement);
    }
  });
});

describe("scanLiquid: parse errors are skipped, not fatal", () => {
  it("records the malformed file in parseErrors and keeps scanning the rest", async () => {
    const { files, findings, parseErrors } = await scanLiquid(themeDir);
    // All three files are collected; the broken one is parsed-then-skipped.
    expect(files).toHaveLength(3);
    expect(parseErrors).toHaveLength(1);
    expect(parseErrors[0]!.file).toMatch(/broken\.liquid$/);
    // The good/bad findings still came through — one bad file didn't abort the scan.
    expect(findings.some((f) => f.file.endsWith("bad.liquid"))).toBe(true);
  });
});

describe("--json report shape (consistent with check)", () => {
  it("builds a JsonReport with zeroed coverage and a blocking summary", async () => {
    const { root, files, findings: raw } = await scanLiquid(themeDir);
    const findings = enrichAll(raw);
    const report = buildJsonReport(
      root,
      files.length,
      { total: 0, declared: 0, registry: 0, traced: 0, opaque: 0, trusted: 0, icons: 0, structural: 0, declare: 0 },
      findings,
    );
    expect(report.tool).toBe("a11y-checker");
    expect(report.filesScanned).toBe(3);
    expect(report.coverage.total).toBe(0);
    expect(report.summary.findings).toBe(findings.length);
    // bad.liquid's findings are blocking with no contract present.
    expect(report.summary.blocking).toBeGreaterThan(0);
    expect(report.findings.every((f) => f.provenance === "liquid")).toBe(true);
  });
});
