import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseUnityDocument } from "../src/unity-ast";
import { scanUnity } from "../src/collect-unity";
import {
  COLOR_ONLY_STATE_RULE_ID,
  scanColorOnlyState,
  unityColorOnlyStateFindings,
  wcagForColorOnlyState,
} from "../src/unity-rule-color-only";

/**
 * Coverage for the Unity "color-only interactive state" rule (#73, child of #66).
 *
 * The rule fires on a uGUI Selectable whose `m_Transition: 1` (ColorTint) conveys
 * interactive state — normal / highlighted / pressed / selected / disabled — by color
 * alone. The fixture pair locks the fires / does-not-fire boundary:
 *   - POSITIVE: the canonical `Button.prefab` (open-project-1 @ 608eac9), whose Button
 *     Selectable uses `m_Transition: 1` — the high-frequency real-corpus case (41/46).
 *   - NEGATIVE: a SpriteSwap Selectable (`m_Transition: 2`), an Animation Selectable
 *     (`m_Transition: 3`), and a None Selectable (`m_Transition: 0`) — each carries a
 *     non-color (or no) state cue, so none is flagged.
 */

const here = dirname(fileURLToPath(import.meta.url));
const unityProject = join(here, "fixtures", "unity-project");
const colorOnlyDir = join(here, "fixtures", "unity-color-only");
// Dedicated, sibling-proof project dir for the project-level scan tests below: a copy
// of the canonical ColorTint Button.prefab + the opaque Binary.prefab, and nothing else.
// `unity-project` is shared across rules (#66 Phase 3), so siblings (e.g. #70's
// LocalizedButton.prefab, itself a ColorTint Selectable) would otherwise leak extra
// findings into a "exactly one finding" assertion. This dir is owned by this test.
const colorOnlyProject = join(here, "fixtures", "unity-color-only-project");
const buttonPrefab = join(unityProject, "Button.prefab");
const spriteSwapPrefab = join(colorOnlyDir, "ToggleSpriteSwap.prefab");
const animationPrefab = join(colorOnlyDir, "ButtonAnimation.prefab");
const nonePrefab = join(colorOnlyDir, "ButtonNoTransition.prefab");

const findingsFor = async (path: string) =>
  unityColorOnlyStateFindings({ file: path, parse: parseUnityDocument(await readFile(path, "utf8")) });

describe("unity color-only state: fires on ColorTint (m_Transition: 1)", () => {
  it("flags the canonical Button.prefab Selectable as color-only state", async () => {
    const findings = await findingsFor(buttonPrefab);
    expect(findings.length).toBe(1);
    const f = findings[0]!;
    expect(f.ruleId).toBe(COLOR_ONLY_STATE_RULE_ID);
    expect(f.file).toBe(buttonPrefab);
    expect(f.provenance).toBe("unity");
  });

  it("maps the finding to WCAG SC 1.4.1 (Use of Color) via the wcag bridge", async () => {
    const findings = await findingsFor(buttonPrefab);
    expect(findings[0]!.wcag).toContain("1.4.1");
    expect(wcagForColorOnlyState()).toContain("1.4.1");
  });
});

describe("unity color-only state: silent on a non-color (or no) state cue", () => {
  it("does NOT flag a SpriteSwap Selectable (m_Transition: 2)", async () => {
    expect(await findingsFor(spriteSwapPrefab)).toHaveLength(0);
  });

  it("does NOT flag an Animation Selectable (m_Transition: 3)", async () => {
    expect(await findingsFor(animationPrefab)).toHaveLength(0);
  });

  it("does NOT flag a None Selectable (m_Transition: 0)", async () => {
    expect(await findingsFor(nonePrefab)).toHaveLength(0);
  });
});

describe("unity color-only state: consumes the collect-unity producer output", () => {
  it("scans a project's resolved widgets (not a re-parse) and flags only ColorTint", async () => {
    const scan = await scanUnity(colorOnlyDir);
    const findings = scanColorOnlyState(scan);
    // The color-only fixture dir holds three Selectables, all non-ColorTint → no findings.
    expect(findings).toHaveLength(0);
  });

  it("flags the ColorTint Selectable when the canonical Button project is scanned", async () => {
    const scan = await scanUnity(colorOnlyProject);
    const findings = scanColorOnlyState(scan);
    expect(findings.length).toBe(1);
    expect(findings[0]!.ruleId).toBe(COLOR_ONLY_STATE_RULE_ID);
    expect(findings[0]!.wcag).toContain("1.4.1");
  });

  it("an opaque (binary) asset contributes no finding, never crashes", async () => {
    const scan = await scanUnity(colorOnlyProject);
    const findings = scanColorOnlyState(scan);
    // Binary.prefab is opaque; only Button.prefab fires.
    expect(findings.every((f) => f.file.endsWith("Button.prefab"))).toBe(true);
  });
});
