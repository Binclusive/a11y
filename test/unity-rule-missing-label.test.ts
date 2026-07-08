/**
 * Tests for the Unity missing-accessible-label rule (#88, child of epic #87) — the
 * finding that the 3-state label resolver (`unity-label-resolve.ts`) was built to feed.
 * An interactive uGUI widget (Button / Toggle / Selectable) whose accessible label
 * resolves to the `Absent` state has no accessible name; this rule emits a `Finding`
 * for it — and ONLY for it.
 *
 * The precision lock (ADR 0004, story 3) is the load-bearing assertion: a `dynamic`
 * (runtime-localized) label and an opaque/binary asset emit NOTHING. Emitting a false
 * `Absent` on a localized widget is the wrong-host-class failure that gets the tool
 * uninstalled, so the rule must never fire on `LocalizedButton.prefab` (dynamic) or
 * `Binary.prefab` (opaque).
 *
 * Fixtures (test/fixtures/unity-project/):
 *   - ButtonNoLabel.prefab  — Button with an Image-only child, no text child → Absent → ONE finding.
 *   - Button.prefab         — Button with a static `m_text` child → Static → NONE.
 *   - LocalizedButton.prefab — Button with an enabled LocalizeStringEvent → Dynamic → NONE.
 *   - Binary.prefab         — non-Force-Text binary asset → opaque → NONE.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseUnityDocument } from "../src/unity-ast";
import {
  MISSING_LABEL_RULE_ID,
  scanMissingLabel,
  unityMissingLabelFindings,
  wcagForMissingLabel,
} from "../src/unity-rule-missing-label";

const projectDir = join(__dirname, "fixtures", "unity-project");

async function loadAsset(name: string) {
  const source = await readFile(join(projectDir, name), "utf8");
  return { file: join(projectDir, name), source, parse: parseUnityDocument(source) };
}

describe("unity-rule-missing-label — the Absent-state missing-accessible-label rule", () => {
  it("fires ONE finding on a Button with no text-bearing child (Absent)", async () => {
    const asset = await loadAsset("ButtonNoLabel.prefab");
    const findings = unityMissingLabelFindings(asset);

    expect(findings).toHaveLength(1);
    const [finding] = findings;
    expect(finding?.ruleId).toBe(MISSING_LABEL_RULE_ID);
    expect(finding?.ruleId).toBe("unity/missing-accessible-label");
    expect(finding?.provenance).toBe("unity");
    expect(finding?.file).toBe(asset.file);
    expect(finding?.line).toBe(0);
    // No contract on the Unity path ⇒ advisory by default (ADR 0010).
    expect(finding?.enforcement).toBe("warn");
    expect(finding?.wcag).toEqual(["1.1.1", "4.1.2"]);
  });

  it("emits NOTHING for a static-label Button (Static is a resolved label, not missing)", async () => {
    const asset = await loadAsset("Button.prefab");
    expect(unityMissingLabelFindings(asset)).toEqual([]);
  });

  it("the precision lock: emits NOTHING for a runtime-localized Button (Dynamic, never a false Absent)", async () => {
    const asset = await loadAsset("LocalizedButton.prefab");
    expect(unityMissingLabelFindings(asset)).toEqual([]);
  });

  it("emits NOTHING for an opaque/binary asset (opaque is reported by the producer, never guessed)", async () => {
    const asset = await loadAsset("Binary.prefab");
    expect(asset.parse.kind).toBe("opaque");
    expect(unityMissingLabelFindings(asset)).toEqual([]);
  });

  it("wcagForMissingLabel exposes the name/role/value SCs (1.1.1 / 4.1.2)", () => {
    expect(wcagForMissingLabel()).toEqual(["1.1.1", "4.1.2"]);
  });

  it("scanMissingLabel walks a whole scan result and merges per-asset findings", async () => {
    const assets = await Promise.all(
      ["Button.prefab", "ButtonNoLabel.prefab", "LocalizedButton.prefab", "Binary.prefab"].map(
        loadAsset,
      ),
    );
    const scan = {
      root: projectDir,
      files: assets.map((a) => a.file),
      assets: assets.map((a) => ({ file: a.file, parse: a.parse })),
    };

    const findings = await scanMissingLabel(scan);

    // Only ButtonNoLabel.prefab is Absent.
    expect(findings).toHaveLength(1);
    expect(findings[0]?.ruleId).toBe(MISSING_LABEL_RULE_ID);
    expect(findings[0]?.file).toBe(join(projectDir, "ButtonNoLabel.prefab"));
  });
});
