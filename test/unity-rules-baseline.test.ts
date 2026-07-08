/**
 * Tests for the Unity PROJECT-LEVEL structural-absence rules (#72), the analog of
 * the Liquid structural-absence suite (`liquid-rules.test.ts`) one altitude up: these
 * scan a whole Unity project directory and emit ONE project-scoped finding per rule,
 * not a per-file flood.
 *
 * The fixtures are two small, real-shaped Unity project dirs under
 * `test/fixtures/unity-projects/`:
 *   - `bare/`     — zero Accessibility refs + no `.inputactions` → BOTH findings fire.
 *   - `equipped/` — an `AccessibilityHierarchy` reference + a `.inputactions` asset →
 *                   NEITHER finding fires (the no-false-positive proof).
 *
 * The `.cs` and `.inputactions` snippets are minimal copies in the shape of
 * `UnityTechnologies/open-project-1` @ 608eac9 (the #66 ground truth: that repo has
 * zero Accessibility refs across the whole tree, and one `.inputactions`).
 */

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  runUnityBaselineRules,
  type UnityProjectFinding,
  wcagForUnityRule,
} from "../src/unity-rules-baseline";

const FIXTURES = join(__dirname, "fixtures", "unity-projects");
const BARE = join(FIXTURES, "bare");
const EQUIPPED = join(FIXTURES, "equipped");

const ruleIds = (findings: readonly UnityProjectFinding[]): string[] =>
  findings.map((f) => f.ruleId).sort();

describe("unity-rules-baseline — project-level structural-absence", () => {
  describe("the bare project (no screen-reader support, no input rebinding)", () => {
    it("fires BOTH project-level findings", async () => {
      const findings = await runUnityBaselineRules(BARE);
      expect(ruleIds(findings)).toEqual([
        "unity/no-input-rebinding",
        "unity/no-screen-reader-support",
      ]);
    });

    it("emits exactly ONE finding per rule (project-scoped, not per-file)", async () => {
      const findings = await runUnityBaselineRules(BARE);
      const counts = findings.reduce<Record<string, number>>((acc, f) => {
        acc[f.ruleId] = (acc[f.ruleId] ?? 0) + 1;
        return acc;
      }, {});
      expect(counts["unity/no-screen-reader-support"]).toBe(1);
      expect(counts["unity/no-input-rebinding"]).toBe(1);
    });

    it("anchors each finding on the project root with the unity provenance", async () => {
      const findings = await runUnityBaselineRules(BARE);
      for (const finding of findings) {
        expect(finding.provenance).toBe("unity");
        expect(finding.file).toBe(BARE);
        expect(finding.line).toBe(0);
        // No contract on the Unity path ⇒ advisory by default (ADR 0010).
        expect(finding.enforcement).toBe("warn");
      }
    });
  });

  describe("the equipped project (has SR support + an .inputactions)", () => {
    it("stays SILENT — no false positives on either rule", async () => {
      const findings = await runUnityBaselineRules(EQUIPPED);
      expect(findings).toEqual([]);
    });
  });

  describe("rule isolation — each rule fires on exactly its own absence", () => {
    it("no-screen-reader-support fires on the bare project independent of rebinding", async () => {
      const bare = await runUnityBaselineRules(BARE);
      expect(bare.some((f) => f.ruleId === "unity/no-screen-reader-support")).toBe(true);
    });

    it("no-input-rebinding fires on the bare project independent of SR support", async () => {
      const bare = await runUnityBaselineRules(BARE);
      expect(bare.some((f) => f.ruleId === "unity/no-input-rebinding")).toBe(true);
    });
  });

  describe("forgiving scan — a missing project dir is an empty (silent) scan", () => {
    it("returns no findings for a non-existent directory rather than throwing", async () => {
      const findings = await runUnityBaselineRules(join(FIXTURES, "does-not-exist"));
      expect(findings).toEqual([]);
    });
  });

  describe("WCAG SC bridge", () => {
    it("maps no-screen-reader-support to Name/Role/Value + Info-and-Relationships", () => {
      expect(wcagForUnityRule("unity/no-screen-reader-support")).toEqual(["1.3.1", "4.1.2"]);
    });

    it("maps no-input-rebinding to Keyboard + Pointer-Gestures motor SCs", () => {
      expect(wcagForUnityRule("unity/no-input-rebinding")).toEqual(["2.1.1", "2.5.1"]);
    });

    it("each fired finding carries its rule's WCAG SC mapping", async () => {
      const findings = await runUnityBaselineRules(BARE);
      for (const finding of findings) {
        expect(finding.wcag).toEqual(wcagForUnityRule(finding.ruleId));
        expect(finding.wcag.length).toBeGreaterThan(0);
      }
    });

    it("returns [] for an unknown rule id (never throws)", () => {
      expect(wcagForUnityRule("unity/does-not-exist")).toEqual([]);
    });
  });
});
