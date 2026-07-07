/**
 * Tests for the Unity finding-emission aggregator (#88, foundation of epic #87) — the
 * single in-process function (`collectUnityFindings`) that is the `collect-unity` analog
 * of `scanLiquid`/`scanSwift`: it takes a project dir, runs `scanUnity`, runs every
 * Unity rule source over the scan, and returns ONE flat canonical `Finding[]` (the
 * `core.ts` shape, every finding `provenance: "unity"`, `layer: "floor"`).
 *
 * It reconciles the three rule sources onto the one `Finding` shape:
 *   - scanColorOnlyState — already canonical `Finding[]` (pass-through).
 *   - runUnityBaselineRules — `UnityProjectFinding[]`, adapted at the seam (stamp `layer:"floor"`).
 *   - the new missing-accessible-label rule (`scanMissingLabel`).
 *
 * This test owns its project-scan fixture subtree — `unity-projects/aggregate/` — rather
 * than asserting the global contents of the shared `unity-project/` dir. Those exact-count
 * assertions ("3 color-only / 6 total") couple to *every* prefab in the scanned dir, so a
 * sibling PR adding an unrelated prefab to a shared dir turns them red on combined `main`
 * even though each PR was green alone (#84; same class as #77). Per the fixture-ownership
 * convention (CLAUDE.md → Conventions), a dir-level scan test that asserts global contents
 * owns a dedicated subtree no sibling mutates. The `aggregate/` fixture holds four prefabs
 * (Button / ButtonNoLabel / LocalizedButton, all ColorTint; Binary, opaque) and NO
 * `.cs` / `.inputactions`, so:
 *   - color-only fires on all 3 graph prefabs (each `m_Transition: 1`) → 3 findings.
 *   - missing-label fires on ButtonNoLabel only (Absent) → 1 finding.
 *   - baseline fires both project rules (no Accessibility ref, no rebinding) → 2 findings.
 * Binary.prefab is opaque → contributes nothing.
 */

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Finding } from "../src/core";
import { collectUnityFindings } from "../src/unity-findings";

// Dedicated, sibling-proof project dir owned by this test (#84 fixture-ownership convention).
const projectDir = join(__dirname, "fixtures", "unity-projects", "aggregate");
const PROJECTS = join(__dirname, "fixtures", "unity-projects");

const ruleIds = (findings: readonly Finding[]): string[] => findings.map((f) => f.ruleId).sort();
const countByRule = (findings: readonly Finding[]): Record<string, number> =>
  findings.reduce<Record<string, number>>((acc, f) => {
    acc[f.ruleId] = (acc[f.ruleId] ?? 0) + 1;
    return acc;
  }, {});

describe("collectUnityFindings — the Unity finding-emission aggregator", () => {
  it("returns one flat canonical Finding[] merging all three rule sources", async () => {
    const findings = await collectUnityFindings(projectDir);
    const counts = countByRule(findings);

    expect(counts["unity/color-only-state"]).toBe(3); // Button + ButtonNoLabel + LocalizedButton
    expect(counts["unity/missing-accessible-label"]).toBe(1); // ButtonNoLabel only
    expect(counts["unity/no-screen-reader-support"]).toBe(1); // no .cs Accessibility ref
    expect(counts["unity/no-input-rebinding"]).toBe(1); // no .inputactions, no rebinding call
    expect(findings).toHaveLength(6);
  });

  it("stamps every finding with provenance:unity and layer:floor (Unity findings are exit-code-affecting)", async () => {
    const findings = await collectUnityFindings(projectDir);
    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) {
      expect(finding.provenance).toBe("unity");
      expect(finding.layer).toBe("floor");
    }
  });

  it("includes the new missing-label finding, WCAG-bridged, only on the Absent widget", async () => {
    const findings = await collectUnityFindings(projectDir);
    const missing = findings.filter((f) => f.ruleId === "unity/missing-accessible-label");
    expect(missing).toHaveLength(1);
    expect(missing[0]?.file).toBe(join(projectDir, "ButtonNoLabel.prefab"));
    expect(missing[0]?.wcag).toEqual(["1.1.1", "4.1.2"]);
  });

  it("the precision lock: the localized and binary fixtures contribute NO missing-label finding", async () => {
    const findings = await collectUnityFindings(projectDir);
    const missingFiles = findings
      .filter((f) => f.ruleId === "unity/missing-accessible-label")
      .map((f) => f.file);
    expect(missingFiles).not.toContain(join(projectDir, "LocalizedButton.prefab"));
    expect(missingFiles).not.toContain(join(projectDir, "Binary.prefab"));
  });

  it("adapts baseline project-rules to the canonical Finding shape with layer:floor", async () => {
    const findings = await collectUnityFindings(projectDir);
    const baseline = findings.filter(
      (f) =>
        f.ruleId === "unity/no-screen-reader-support" || f.ruleId === "unity/no-input-rebinding",
    );
    expect(ruleIds(baseline)).toEqual(["unity/no-input-rebinding", "unity/no-screen-reader-support"]);
    for (const finding of baseline) {
      expect(finding.layer).toBe("floor");
      expect(finding.provenance).toBe("unity");
      expect(finding.line).toBe(0);
      expect(finding.file).toBe(projectDir); // anchored on the resolved project root
      expect(finding.wcag.length).toBeGreaterThan(0); // WCAG-bridged at the source
    }
  });

  it("the equipped project (Accessibility ref + .inputactions) fires NEITHER baseline finding", async () => {
    const findings = await collectUnityFindings(join(PROJECTS, "equipped"));
    const ids = ruleIds(findings);
    expect(ids).not.toContain("unity/no-screen-reader-support");
    expect(ids).not.toContain("unity/no-input-rebinding");
  });

  it("the bare project (no prefabs, no a11y) fires the two baseline findings", async () => {
    const findings = await collectUnityFindings(join(PROJECTS, "bare"));
    expect(ruleIds(findings)).toEqual([
      "unity/no-input-rebinding",
      "unity/no-screen-reader-support",
    ]);
    for (const finding of findings) {
      expect(finding.layer).toBe("floor");
      expect(finding.provenance).toBe("unity");
    }
  });

  it("a missing project dir is an empty scan (no findings, never a throw)", async () => {
    const findings = await collectUnityFindings(join(__dirname, "fixtures", "does-not-exist-xyz"));
    // No prefabs and no project tree → no per-asset findings; baseline rules return []
    // on a non-existent dir, so the whole aggregate is empty.
    expect(findings).toEqual([]);
  });
});
