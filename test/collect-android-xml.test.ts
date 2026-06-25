import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildJsonReport } from "../src/cli";
import { collectAndroidXmlFiles, scanAndroidXml } from "../src/collect-android-xml";
import { enrichAll } from "../src/corpus";

/**
 * Coverage for the Android XML collector boundary (ADR 0006, the in-TS lane). Drives
 * the in-process parse + structural-absence rules over a fixture `res/` tree:
 * violations are caught in `bad.xml`, none in `good.xml`, a malformed file is skipped
 * (not fatal), non-layout XML (`values/strings.xml`) is left opaque, and the `--json`
 * report shape matches `check`. No browser, no JVM, no network.
 */

const here = dirname(fileURLToPath(import.meta.url));
const projectDir = join(here, "fixtures", "android-layout");

const ruleIdsIn = (file: string, findings: readonly { ruleId: string; file: string }[]) =>
  findings.filter((f) => f.file.endsWith(file)).map((f) => f.ruleId);

describe("collectAndroidXmlFiles: the walk", () => {
  it("collects every .xml under the project, descending into res/ subdirs", async () => {
    const files = await collectAndroidXmlFiles(projectDir);
    // bad.xml, good.xml, broken.xml, values/strings.xml — AndroidManifest excluded.
    expect(files).toHaveLength(4);
    expect(files.every((f) => f.endsWith(".xml"))).toBe(true);
  });

  it("returns [] for a missing/unreadable directory instead of throwing", async () => {
    await expect(collectAndroidXmlFiles(join(projectDir, "nope"))).resolves.toEqual([]);
  });
});

describe("scanAndroidXml: findings", () => {
  it("finds the three structural violations in bad.xml", async () => {
    const { findings } = await scanAndroidXml(projectDir);
    const bad = ruleIdsIn("bad.xml", findings);
    expect(bad).toContain("android-xml/image-no-label");
    expect(bad).toContain("android-xml/control-no-name");
    expect(bad).toContain("android-xml/editable-no-label");
  });

  it("fires both image-no-label AND control-no-name on the unnamed ImageButton", async () => {
    const { findings } = await scanAndroidXml(projectDir);
    const onImageButton = findings.filter(
      (f) => f.file.endsWith("bad.xml") && f.message.includes("<ImageButton>"),
    );
    // The <ImageButton> is both an unlabeled image (1.1.1) and an unnamed control
    // (4.1.2) — both must fire, like the SwiftUI tappable-image case.
    expect(onImageButton.map((f) => f.ruleId).sort()).toEqual([
      "android-xml/control-no-name",
      "android-xml/image-no-label",
    ]);
  });

  it("does not flag the decorative image or the labelled Button in bad.xml", async () => {
    const { findings } = await scanAndroidXml(projectDir);
    const bad = findings.filter((f) => f.file.endsWith("bad.xml"));
    // 3 expected: ImageView(no desc), ImageButton(image+control = 2), EditText(no label).
    // The decorative ImageView and the text Button contribute nothing.
    expect(bad).toHaveLength(4);
  });

  it("reports nothing for good.xml (every control has an accessible name)", async () => {
    const { findings } = await scanAndroidXml(projectDir);
    expect(ruleIdsIn("good.xml", findings)).toEqual([]);
  });

  it("every finding carries provenance 'android-xml' and a contract-derived enforcement", async () => {
    const { findings } = await scanAndroidXml(projectDir);
    expect(findings.length).toBeGreaterThan(0);
    for (const f of findings) {
      expect(f.provenance).toBe("android-xml");
      expect(["block", "warn"]).toContain(f.enforcement);
    }
  });
});

describe("scanAndroidXml: non-layout XML and parse errors", () => {
  it("skips non-layout XML (values/strings.xml) — only the two layouts are scanned", async () => {
    const { files } = await scanAndroidXml(projectDir);
    expect(files).toHaveLength(2);
    expect(files.every((f) => f.endsWith("bad.xml") || f.endsWith("good.xml"))).toBe(true);
  });

  it("records the malformed file in parseErrors and keeps scanning the rest", async () => {
    const { findings, parseErrors } = await scanAndroidXml(projectDir);
    expect(parseErrors).toHaveLength(1);
    expect(parseErrors[0]!.file).toMatch(/broken\.xml$/);
    // The good/bad findings still came through — one bad file didn't abort the scan.
    expect(findings.some((f) => f.file.endsWith("bad.xml"))).toBe(true);
  });
});

describe("--json report shape (consistent with check)", () => {
  it("builds a JsonReport with zeroed coverage and a blocking summary", async () => {
    const { root, files, findings: raw } = await scanAndroidXml(projectDir);
    const findings = enrichAll(raw);
    const report = buildJsonReport(
      root,
      files.length,
      { total: 0, declared: 0, registry: 0, traced: 0, opaque: 0, trusted: 0, icons: 0, structural: 0, declare: 0 },
      findings,
    );
    expect(report.tool).toBe("a11y-checker");
    expect(report.filesScanned).toBe(2);
    expect(report.coverage.total).toBe(0);
    expect(report.summary.findings).toBe(findings.length);
    // bad.xml's findings are blocking with no contract present.
    expect(report.summary.blocking).toBeGreaterThan(0);
    expect(report.findings.every((f) => f.provenance === "android-xml")).toBe(true);
  });
});
