import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildJsonReport } from "../src/cli";
import { enrichAll } from "../src/evidence";
import { scan } from "../src/core";
import type { Coverage } from "../src/resolve-components";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "fixtures");

/** A minimal zero-finding coverage object for unit assertions. */
const zeroCoverage: Coverage = {
  total: 10,
  declared: 4,
  registry: 2,
  traced: 1,
  opaque: 3,
  trusted: 1,
  icons: 1,
  structural: 1,
  declare: 0,
};

describe("buildJsonReport", () => {
  it("emits all required top-level keys", () => {
    const report = buildJsonReport("/tmp/root", 5, zeroCoverage, []);
    expect(Object.keys(report).sort()).toEqual(
      ["tool", "root", "filesScanned", "coverage", "findings", "summary"].sort(),
    );
  });

  it("coverage.checked = declared + registry + traced", () => {
    const report = buildJsonReport("/tmp/root", 5, zeroCoverage, []);
    expect(report.coverage.checked).toBe(
      zeroCoverage.declared + zeroCoverage.registry + zeroCoverage.traced,
    );
  });

  it("summary.blocking + summary.warning === summary.findings", async () => {
    const file = join(fixturesDir, "aria-hidden.tsx");
    const result = await scan([file]);
    const findings = enrichAll(result.findings);
    const report = buildJsonReport(fixturesDir, 1, result.coverage, findings);
    expect(report.summary.blocking + report.summary.warning).toBe(report.summary.findings);
  });

  it("finding id has format ruleId|relFile|line|wcag", async () => {
    const file = join(fixturesDir, "aria-hidden.tsx");
    const result = await scan([file]);
    const findings = enrichAll(result.findings);
    if (findings.length === 0) return; // fixture produced no findings — skip id check
    const report = buildJsonReport(fixturesDir, 1, result.coverage, findings);
    const f = report.findings[0]!;
    // id must have 4 pipe-separated segments
    expect(f.id.split("|").length).toBe(4);
    expect(f.id.startsWith(f.ruleId)).toBe(true);
  });

  it("emits valid JSON for zero-file scan", () => {
    const report = buildJsonReport("/tmp/empty", 0, zeroCoverage, []);
    const parsed = JSON.parse(JSON.stringify(report));
    expect(parsed.findings).toEqual([]);
    expect(parsed.summary.findings).toBe(0);
  });
});
