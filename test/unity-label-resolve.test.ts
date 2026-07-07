import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseUnityDocument, type UnityGameObject, type UnityGraph } from "../src/unity-ast";
import {
  LOCALIZE_STRING_EVENT_GUID,
  resolveUnityLabel,
  UnityLabel,
} from "../src/unity-label-resolve";

/**
 * Coverage for the Unity 3-state label seam (#70, child of #66) — the no-false-positive
 * precision lock for the Unity producer. The label of a uGUI interactive widget lives
 * on a child TMP's `m_text`, but an enabled LocalizeStringEvent with a real table
 * reference injects it at runtime, making `m_text` a placeholder. The resolver must
 * return a 3-STATE result (`Static | Dynamic | Absent`), never a boolean:
 *
 *   - Static  — `Button.prefab`: child TMP `m_text: X`, LocalizeStringEvent present but
 *               DISABLED with an empty reference (the real base prefab from
 *               open-project-1 @ 608eac98).
 *   - Dynamic — `LocalizedButton.prefab`: the REAL `Tab_Item.prefab` from open-project-1,
 *               a Button whose child TMP carries an ENABLED LocalizeStringEvent with a
 *               non-empty table reference (`GUID:…` + non-zero `m_KeyId`). The visible
 *               label is runtime-injected → opaque, and CRITICALLY must NOT resolve to
 *               Absent (the false-positive a `m_text`-only read would emit).
 *   - Absent  — `ButtonNoLabel.prefab`: a Button with an Image-only child and no
 *               text-bearing child → the genuine missing-label finding.
 */

const here = dirname(fileURLToPath(import.meta.url));
const projectDir = join(here, "fixtures", "unity-project");

const BUTTON_GUID = "4e29b1a8efbd4b44bb3f3716e73f07ff";

/** Parse a fixture and return both the graph and the raw source (the resolver reads the
 * source for the LocalizeStringEvent fields the L1 AST does not capture). */
async function loadFixture(name: string): Promise<{ graph: UnityGraph; source: string }> {
  const source = await readFile(join(projectDir, name), "utf8");
  const parsed = parseUnityDocument(source);
  if (parsed.kind !== "graph") {
    throw new Error(`fixture ${name} did not parse to a graph: ${parsed.kind}`);
  }
  return { graph: parsed.graph, source };
}

/** Find the interactive widget GameObject — the one carrying a Button component guid. */
function findButton(graph: UnityGraph): UnityGameObject {
  const button = [...graph.gameObjects.values()].find((go) =>
    go.components.some((c) => c.scriptGuid === BUTTON_GUID),
  );
  if (!button) throw new Error("no Button widget GameObject in fixture");
  return button;
}

describe("resolveUnityLabel: the 3-state label seam", () => {
  it("Static — a child TMP with m_text and a DISABLED LocalizeStringEvent resolves to Static(text)", async () => {
    const { graph, source } = await loadFixture("Button.prefab");
    const button = findButton(graph);

    const label = resolveUnityLabel(graph, button, source);

    expect(label).toEqual(UnityLabel.static("X"));
    expect(label.kind).toBe("static");
  });

  it("Dynamic — a real localized button (enabled LocalizeStringEvent + table reference) resolves to Dynamic", async () => {
    const { graph, source } = await loadFixture("LocalizedButton.prefab");
    const button = findButton(graph);

    const label = resolveUnityLabel(graph, button, source);

    expect(label.kind).toBe("dynamic");
    expect(label).toEqual(UnityLabel.dynamic());
  });

  it("Dynamic NOT Absent — the no-false-positive lock: a localized label is opaque, never flagged missing", async () => {
    // This is the precision crux (story 3). The child TMP's m_text is the placeholder
    // "Button"; the real label comes from the localization table at runtime. A naive
    // reader must NOT treat this as a resolved/absent label — it stays opaque.
    const { graph, source } = await loadFixture("LocalizedButton.prefab");
    const button = findButton(graph);

    const label = resolveUnityLabel(graph, button, source);

    expect(label.kind).not.toBe("absent");
    expect(label.kind).not.toBe("static");
    expect(label.kind).toBe("dynamic");
  });

  it("Absent — a Button with no text-bearing child resolves to Absent (the genuine finding)", async () => {
    const { graph, source } = await loadFixture("ButtonNoLabel.prefab");
    const button = findButton(graph);

    const label = resolveUnityLabel(graph, button, source);

    expect(label).toEqual(UnityLabel.absent());
    expect(label.kind).toBe("absent");
  });

  it("the static-vs-localized fixture pair: only the static one carries a readable text, the localized one is opaque", async () => {
    const staticFix = await loadFixture("Button.prefab");
    const localizedFix = await loadFixture("LocalizedButton.prefab");

    const staticLabel = resolveUnityLabel(
      staticFix.graph,
      findButton(staticFix.graph),
      staticFix.source,
    );
    const localizedLabel = resolveUnityLabel(
      localizedFix.graph,
      findButton(localizedFix.graph),
      localizedFix.source,
    );

    // The static button yields a concrete text; the localized button is opaque and is
    // NOT the absent (flagged) state — the fixture-pair no-false-positive contract (AC 4).
    expect(staticLabel.kind).toBe("static");
    expect(localizedLabel.kind).toBe("dynamic");
    expect(localizedLabel.kind).not.toBe("absent");
  });

  it("exports the grounded LocalizeStringEvent guid constant", () => {
    expect(LOCALIZE_STRING_EVENT_GUID).toBe("56eb0353ae6e5124bb35b17aff880f16");
  });
});
