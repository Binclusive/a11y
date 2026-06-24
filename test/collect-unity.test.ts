import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  collectUnityFiles,
  scanUnity,
  type UnityScanResult,
} from "../src/collect-unity";
import {
  parseUnityDocument,
  resolveComponentIdentity,
  childGameObjects,
  type UnityGraph,
} from "../src/unity-ast";
import { resolveWidgetGuid, UNITY_BUILTIN_GUIDS } from "../src/unity-guid-registry";

/**
 * Coverage for the Unity producer foundation (#71). The real fixture is the canonical
 * Button prefab from `UnityTechnologies/open-project-1` @ 608eac98 — a GameObject
 * "Button" holding Image + Button components with a child "Text (TMP)" holding a
 * TextMeshProUGUI (`m_text: X`) plus a custom (LocalizeStringEvent) MonoBehaviour.
 *
 * The load-bearing assertions are the precision invariant: built-in widgets resolve
 * via the GUID registry, a custom-guid component stays OPAQUE (never wrong-host), and
 * a binary (non-Force-Text) asset is reported OPAQUE rather than guessed.
 */

const here = dirname(fileURLToPath(import.meta.url));
const projectDir = join(here, "fixtures", "unity-project");
const buttonPrefab = join(projectDir, "Button.prefab");
const binaryPrefab = join(projectDir, "Binary.prefab");

// The real custom-component guid present in the fixture (Unity Localization's
// LocalizeStringEvent) — NOT a built-in widget, so it must resolve opaque.
const LOCALIZE_STRING_EVENT_GUID = "56eb0353ae6e5124bb35b17aff880f16";

const parseFixture = async (path: string) => parseUnityDocument(await readFile(path, "utf8"));

describe("unity-guid-registry: built-in widget identity is a static lookup", () => {
  it("resolves the three verified constant guids to their widget kinds", () => {
    expect(resolveWidgetGuid("4e29b1a8efbd4b44bb3f3716e73f07ff")?.widget).toBe("Button");
    expect(resolveWidgetGuid("fe87c0e1cc204ed48ad3b37840f39efc")?.widget).toBe("Image");
    expect(resolveWidgetGuid("f4688fdb7df04437aeb418b961361dc5")?.widget).toBe(
      "TextMeshProUGUI",
    );
  });

  it("is case- and presence-insensitive to guid formatting noise", () => {
    expect(resolveWidgetGuid("4E29B1A8EFBD4B44BB3F3716E73F07FF")?.widget).toBe("Button");
    expect(resolveWidgetGuid("  fe87c0e1cc204ed48ad3b37840f39efc  ")?.widget).toBe("Image");
  });

  it("resolves a custom-MonoBehaviour guid to undefined (opaque), never a wrong widget", () => {
    expect(resolveWidgetGuid(LOCALIZE_STRING_EVENT_GUID)).toBeUndefined();
    expect(resolveWidgetGuid("ffffffffffffffffffffffffffffffff")).toBeUndefined();
    expect(resolveWidgetGuid("")).toBeUndefined();
  });

  it("every registry entry carries a host and is keyed by a 32-hex guid", () => {
    expect(UNITY_BUILTIN_GUIDS.length).toBeGreaterThanOrEqual(3);
    for (const entry of UNITY_BUILTIN_GUIDS) {
      expect(entry.guid).toMatch(/^[0-9a-f]{32}$/);
      expect(entry.widget.length).toBeGreaterThan(0);
    }
  });
});

describe("parseUnityDocument: Force-Text serialization-mode detection", () => {
  it("parses a Force-Text (%YAML) prefab into a walkable graph", async () => {
    const result = await parseFixture(buttonPrefab);
    expect(result.kind).toBe("graph");
    if (result.kind !== "graph") return;
    expect(result.graph.gameObjects.size).toBeGreaterThan(0);
  });

  it("reports a binary (non-Force-Text) asset as OPAQUE, not a silent skip", async () => {
    const result = await parseFixture(binaryPrefab);
    expect(result.kind).toBe("opaque");
    if (result.kind !== "opaque") return;
    expect(result.reason).toBe("binary");
  });
});

describe("the Button prefab graph: identity + m_Children walk", () => {
  it("resolves the GameObject 'Button' Image + Button components via the registry", async () => {
    const result = await parseFixture(buttonPrefab);
    expect(result.kind).toBe("graph");
    if (result.kind !== "graph") return;
    const graph = result.graph;

    const button = [...graph.gameObjects.values()].find((g) => g.name === "Button");
    expect(button).toBeDefined();

    const widgets = button!.components
      .map((c) => resolveComponentIdentity(graph, c))
      .filter((id) => id.kind === "widget")
      .map((id) => (id.kind === "widget" ? id.widget : ""));
    expect(widgets).toContain("Button");
    expect(widgets).toContain("Image");
  });

  it("a custom MonoBehaviour (LocalizeStringEvent) on the child resolves OPAQUE, never wrong-host", async () => {
    const result = await parseFixture(buttonPrefab);
    if (result.kind !== "graph") throw new Error("expected graph");
    const graph = result.graph;

    const customComponents = [...graph.components.values()].filter(
      (c) => c.scriptGuid === LOCALIZE_STRING_EVENT_GUID,
    );
    expect(customComponents.length).toBeGreaterThan(0);
    for (const c of customComponents) {
      expect(resolveComponentIdentity(graph, c).kind).toBe("opaque");
    }
  });

  it("the m_Children walk from 'Button' reaches the child GameObject holding the TMP", async () => {
    const result = await parseFixture(buttonPrefab);
    if (result.kind !== "graph") throw new Error("expected graph");
    const graph = result.graph;

    const button = [...graph.gameObjects.values()].find((g) => g.name === "Button")!;
    const children = childGameObjects(graph, button);
    expect(children.map((c) => c.name)).toContain("Text (TMP)");

    const textChild = children.find((c) => c.name === "Text (TMP)")!;
    const childWidgets = textChild.components
      .map((c) => resolveComponentIdentity(graph, c))
      .filter((id) => id.kind === "widget")
      .map((id) => (id.kind === "widget" ? id.widget : ""));
    expect(childWidgets).toContain("TextMeshProUGUI");
  });
});

describe("collectUnityFiles: the walk", () => {
  it("collects .prefab and .unity files under the project, skipping build dirs", async () => {
    const files = await collectUnityFiles(projectDir);
    expect(files.some((f) => f.endsWith("Button.prefab"))).toBe(true);
    expect(files.every((f) => f.endsWith(".prefab") || f.endsWith(".unity"))).toBe(true);
  });

  it("returns [] for a missing directory instead of throwing", async () => {
    await expect(collectUnityFiles(join(projectDir, "nope"))).resolves.toEqual([]);
  });
});

describe("scanUnity: producer boundary mirrors scanLiquid", () => {
  it("parses each file into a graph or records it opaque, never crashing", async () => {
    const result: UnityScanResult = await scanUnity(projectDir);
    expect(result.root).toContain("unity-project");
    expect(result.assets.length).toBeGreaterThanOrEqual(2);

    const button = result.assets.find((a) => a.file.endsWith("Button.prefab"));
    expect(button?.parse.kind).toBe("graph");

    const binary = result.assets.find((a) => a.file.endsWith("Binary.prefab"));
    expect(binary?.parse.kind).toBe("opaque");
    if (binary?.parse.kind === "opaque") expect(binary.parse.reason).toBe("binary");
  });
});
