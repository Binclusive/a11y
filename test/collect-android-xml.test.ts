import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  collectAndroidLayoutFiles,
  findingsForSource,
  isAndroidLayoutFile,
  parseAndroidLayout,
  scanAndroidXml,
} from "../src/collect-android-xml";
import { detectAndroid, detectStack } from "../src/detect-stack";

/**
 * Coverage for the Android XML layout collector. Drives the in-process parser +
 * the two structural-absence rules over a fixture Android project:
 *   - `bad_layout.xml` exercises every POSITIVE case (an unlabeled ImageView /
 *     ImageButton / Button / clickable container) — including the dual emission
 *     where one unlabeled `ImageButton` is BOTH an image and a control;
 *   - `good_layout.xml` exercises every NEGATIVE case (labeled, `@null`
 *     decorative, `importantForAccessibility="no"`, `tools:ignore`, and a
 *     clickable container labeled by a text-bearing child) — none flag.
 * No browser, no network, no second toolchain.
 */

const here = dirname(fileURLToPath(import.meta.url));
const projectDir = join(here, "fixtures", "android-xml");

const rulesIn = (file: string, findings: readonly { ruleId: string; file: string }[]) =>
  findings.filter((f) => f.file.endsWith(file)).map((f) => f.ruleId);

describe("isAndroidLayoutFile: the res/layout filter", () => {
  it("accepts a file in res/layout and a qualified res/layout-land dir", () => {
    expect(isAndroidLayoutFile(join("a", "res", "layout", "main.xml"))).toBe(true);
    expect(isAndroidLayoutFile(join("a", "res", "layout-land", "main.xml"))).toBe(true);
    expect(isAndroidLayoutFile(join("a", "res", "layout-sw600dp", "main.xml"))).toBe(true);
  });

  it("rejects non-layout resource dirs and non-xml files", () => {
    expect(isAndroidLayoutFile(join("a", "res", "values", "strings.xml"))).toBe(false);
    expect(isAndroidLayoutFile(join("a", "res", "drawable", "ic.xml"))).toBe(false);
    expect(isAndroidLayoutFile(join("a", "layout", "main.xml"))).toBe(false); // parent not `res`
    expect(isAndroidLayoutFile(join("a", "res", "layout", "main.png"))).toBe(false);
  });
});

describe("collectAndroidLayoutFiles: the walk", () => {
  it("collects only res/layout* xml, skipping res/values and AndroidManifest", async () => {
    const files = await collectAndroidLayoutFiles(projectDir);
    expect(files).toHaveLength(3); // layout/bad, layout/good, layout-land/land_variant
    expect(files.every((f) => f.endsWith(".xml"))).toBe(true);
    expect(files.some((f) => f.endsWith(join("layout-land", "land_variant.xml")))).toBe(true);
    expect(files.some((f) => f.includes(`${join("res", "values")}`))).toBe(false);
  });

  it("returns [] for a missing directory instead of throwing", async () => {
    await expect(collectAndroidLayoutFiles(join(projectDir, "nope"))).resolves.toEqual([]);
  });
});

describe("the two rules: positives (bad_layout.xml)", () => {
  it("flags an unlabeled ImageView (image-no-label)", async () => {
    const { findings } = await scanAndroidXml(projectDir);
    const bad = rulesIn("bad_layout.xml", findings);
    expect(bad.filter((r) => r === "android-xml/image-no-label").length).toBeGreaterThanOrEqual(1);
  });

  it("flags an unlabeled ImageButton as BOTH image-no-label and control-no-name (same line)", async () => {
    const src = `<ImageButton android:id="@+id/p" android:src="@drawable/x" />`;
    const f = findingsForSource("x.xml", src);
    expect(f.map((x) => x.ruleId).sort()).toEqual([
      "android-xml/control-no-name",
      "android-xml/image-no-label",
    ]);
    expect(new Set(f.map((x) => x.line))).toEqual(new Set([1])); // both on the element's line
  });

  it("flags a Button with no text and a clickable container with no labeled child", async () => {
    const { findings } = await scanAndroidXml(projectDir);
    const bad = rulesIn("bad_layout.xml", findings);
    // ImageView(image) + ImageButton(image+control) + Button(control) + FrameLayout(control)
    expect(bad.filter((r) => r === "android-xml/control-no-name").length).toBe(3);
    expect(bad.filter((r) => r === "android-xml/image-no-label").length).toBe(2);
  });

  it("every finding carries provenance 'android-xml' and a contract-derived enforcement", async () => {
    const { findings } = await scanAndroidXml(projectDir);
    expect(findings.length).toBeGreaterThan(0);
    for (const f of findings) {
      expect(f.provenance).toBe("android-xml");
      expect(["block", "warn"]).toContain(f.enforcement);
      expect(f.wcag.length).toBeGreaterThan(0);
    }
  });
});

describe("the two rules: negatives (good_layout.xml) — no false positives on labeled controls", () => {
  it("flags nothing: labeled, @null decorative, importantForAccessibility, tools:ignore, descendant-labeled", async () => {
    const { findings } = await scanAndroidXml(projectDir);
    expect(rulesIn("good_layout.xml", findings)).toEqual([]);
  });

  it("contentDescription=\"@null\" marks an image decorative → no image-no-label", () => {
    const decorative = `<ImageView android:src="@drawable/x" android:contentDescription="@null" />`;
    expect(findingsForSource("x.xml", decorative)).toEqual([]);
    const unlabeled = `<ImageView android:src="@drawable/x" />`;
    expect(findingsForSource("x.xml", unlabeled).map((f) => f.ruleId)).toEqual([
      "android-xml/image-no-label",
    ]);
  });
});

describe("tools:ignore inherits to descendants (Android lint subtree scoping)", () => {
  it("suppresses a child's finding when an ancestor waives ContentDescription", () => {
    const src = `<merge tools:ignore="ContentDescription"><ImageView android:src="@drawable/x" /></merge>`;
    expect(findingsForSource("x.xml", src)).toEqual([]);
  });
});

describe("the parser is line-aware across multi-line start tags", () => {
  it("reports the line of the element's '<', not its last attribute", () => {
    const src = ["<root>", "", "  <ImageView", '    android:src="@drawable/x" />', "</root>"].join("\n");
    const f = findingsForSource("x.xml", src);
    expect(f).toHaveLength(1);
    expect(f[0]?.line).toBe(3);
  });

  it("builds a nested tree", () => {
    const roots = parseAndroidLayout(`<a><b/><c><d/></c></a>`);
    expect(roots).toHaveLength(1);
    expect(roots[0]?.name).toBe("a");
    expect(roots[0]?.children.map((n) => n.name)).toEqual(["b", "c"]);
    expect(roots[0]?.children[1]?.children.map((n) => n.name)).toEqual(["d"]);
  });
});

describe("detect-stack recognizes an Android project (so the collector is selected)", () => {
  it("detectAndroid is true for the fixture (gradle + AndroidManifest + res/layout)", () => {
    expect(detectAndroid(projectDir)).toBe(true);
  });

  it("detectStack routes an Android repo to language 'android-xml'", () => {
    const stack = detectStack(projectDir, []);
    expect(stack.language).toBe("android-xml");
    expect(stack.framework).toBe("android");
  });

  it("a plain web repo is NOT misread as Android", () => {
    expect(detectAndroid(here)).toBe(false); // the test/ dir — no gradle/manifest
  });
});
