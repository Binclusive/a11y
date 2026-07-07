/**
 * The Android XML layout STATIC collector — an IN-PROCESS producer of
 * {@link Finding}s, parallel to `collect-swift.ts` (SwiftUI) and
 * `collect-liquid.ts` (Shopify Liquid).
 *
 * Unlike the SwiftUI collector — which shells to an out-of-process SwiftSyntax
 * binary because SwiftSyntax can't run from Node — Android layouts are plain XML
 * and parse perfectly well in-process, so there is NO second toolchain here: a
 * thin line-aware element scanner ({@link parseAndroidLayout}) walks each
 * layout file into a node tree, and two structural-absence rules read each
 * element's attributes (and, for controls, its subtree) to decide whether it
 * carries an accessible name.
 *
 * The two rules mirror the SwiftUI two-rule shape (#109):
 *   - `android-xml/image-no-label` (WCAG 1.1.1) — an image-presenting widget
 *     (`ImageView` / `ImageButton`) that exposes no `android:contentDescription`.
 *     A decorative opt-out — `contentDescription="@null"` or
 *     `importantForAccessibility="no"` — is honored, not flagged.
 *   - `android-xml/control-no-name` (WCAG 4.1.2) — an interactive control (a
 *     `Button` / `ImageButton`, or any element marked `android:clickable="true"`)
 *     that exposes no accessible name. The name may come from the control itself
 *     (`contentDescription` / `android:text` / `android:hint`) OR — for a
 *     clickable CONTAINER — from a descendant that carries text or a
 *     contentDescription (Android announces a clickable group by its labeled
 *     children). This descendant-climb is the Android analog of the SwiftUI
 *     collector's ancestor-climb: it stops a label on a child from reading as a
 *     false positive on the wrapping clickable group.
 *
 * Both rules honor Android lint's own suppression seam: `tools:ignore="ContentDescription"`
 * on an element — or on any of its ancestors, exactly as Android Studio's lint
 * scopes a suppression to a subtree — silences both rules for it, so the
 * collector never re-flags what the team has already deliberately waived.
 *
 * An `ImageButton` is BOTH an image widget and a control, so an unlabeled one
 * yields two findings on the same line (one per rule) — the proven prototype
 * behavior the `experiments/android-matrix` corpus reproduces.
 */

import { readdir, readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { contractForFiles, enforcementFor } from "./config-scan";
import type { Finding } from "./core";

/** The two Android-XML static rule ids this collector emits. */
export type AndroidXmlRuleId = "android-xml/image-no-label" | "android-xml/control-no-name";

/** Build/generated dirs that are never layout source — skipped on the walk. The
 * Android ones (`build`, `.gradle`, `.idea`) hold generated/merged resources;
 * the rest match the other collectors' skip set. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".gradle",
  ".idea",
  ".cxx",
  "intermediates",
]);

/**
 * A layout XML file is one named `*.xml` living directly inside a `res/layout…`
 * directory: `res/layout/foo.xml`, `res/layout-land/foo.xml`,
 * `res/layout-sw600dp/foo.xml`, etc. The resource-qualifier suffix on `layout`
 * is arbitrary (orientation, size, locale…), so we match any directory whose
 * name is `layout` or starts with `layout-`, and require its parent to be `res`
 * — that pairing is what distinguishes a real Android layout resource from an
 * unrelated `layout/` directory elsewhere in a tree.
 */
export function isAndroidLayoutFile(absPath: string): boolean {
  if (!absPath.endsWith(".xml")) return false;
  const parts = absPath.split(sep);
  if (parts.length < 3) return false;
  const dir = parts[parts.length - 2] as string;
  const parent = parts[parts.length - 3] as string;
  const isLayoutDir = dir === "layout" || dir.startsWith("layout-");
  return parent === "res" && isLayoutDir;
}

/**
 * Recursively collect the `layout` resource `.xml` files under `dir`, skipping
 * build/generated dirs. A missing or unreadable directory yields `[]` rather
 * than throwing — a non-existent scan target is an empty scan, the forgiving
 * contract the other collectors give the CLI.
 */
export async function collectAndroidLayoutFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...(await collectAndroidLayoutFiles(full)));
    } else if (entry.isFile() && isAndroidLayoutFile(full)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * One element from an Android layout, as a tree node: its local widget name (the
 * last `.`-segment of a possibly-qualified tag —
 * `androidx.appcompat.widget.AppCompatImageButton` → `AppCompatImageButton`),
 * its attribute map (raw `name → value`, namespace prefix kept), the 1-based
 * source `line` the `<` sits on (the location the rules report), and its child
 * elements (empty for a self-closing/leaf element).
 */
export interface AndroidNode {
  readonly name: string;
  readonly line: number;
  readonly attrs: ReadonlyMap<string, string>;
  readonly children: readonly AndroidNode[];
}

interface MutableNode {
  name: string;
  line: number;
  attrs: Map<string, string>;
  children: MutableNode[];
}

/**
 * Parse an Android layout XML string into a tree of element nodes, line-aware.
 *
 * A hand-rolled scanner (not a DOM parser) because the rules need the START-tag
 * line + attributes + nesting, and a streaming scan keeps the exact line number
 * of each `<` — the location the prototype reported and the corpus baseline
 * pins. The scanner skips the `<?xml …?>` declaration, comments, CDATA, and
 * doctypes; it reads attribute values respecting quotes, so a multi-line start
 * tag (ubiquitous in Android layouts) is parsed as one element anchored on the
 * line of its `<`. Returns the top-level node(s) — usually one root, but a
 * `<merge>` or malformed file may yield several.
 */
export function parseAndroidLayout(source: string): AndroidNode[] {
  const roots: MutableNode[] = [];
  const stack: MutableNode[] = [];
  const n = source.length;
  let i = 0;
  let line = 1;

  const step = (): void => {
    if (source[i] === "\n") line++;
    i++;
  };
  const push = (node: MutableNode): void => {
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(node);
    else roots.push(node);
  };

  while (i < n) {
    if (source[i] !== "<") {
      step();
      continue;
    }
    const next = source[i + 1];
    if (next === "?") {
      while (i < n && !(source[i] === "?" && source[i + 1] === ">")) step();
      step();
      step();
      continue;
    }
    if (next === "!") {
      if (source.startsWith("<!--", i)) {
        while (i < n && !source.startsWith("-->", i)) step();
        for (let k = 0; k < 3 && i < n; k++) step();
      } else {
        while (i < n && source[i] !== ">") step();
        if (i < n) step();
      }
      continue;
    }
    if (next === "/") {
      // closing tag </name> — pop one level
      while (i < n && source[i] !== ">") step();
      if (i < n) step();
      if (stack.length > 0) stack.pop();
      continue;
    }

    // an element start tag
    const tagLine = line;
    step(); // '<'
    let name = "";
    while (i < n && !/[\s/>]/.test(source[i] as string)) {
      name += source[i];
      step();
    }
    const attrs = new Map<string, string>();
    let selfClosing = false;
    while (i < n) {
      while (i < n && /\s/.test(source[i] as string)) step();
      if (i >= n) break;
      if (source[i] === "/" && source[i + 1] === ">") {
        selfClosing = true;
        step();
        step();
        break;
      }
      if (source[i] === ">") {
        step();
        break;
      }
      let attrName = "";
      while (i < n && !/[\s=/>]/.test(source[i] as string)) {
        attrName += source[i];
        step();
      }
      while (i < n && /\s/.test(source[i] as string)) step();
      let attrValue = "";
      if (source[i] === "=") {
        step();
        while (i < n && /\s/.test(source[i] as string)) step();
        const quote = source[i];
        if (quote === '"' || quote === "'") {
          step();
          while (i < n && source[i] !== quote) {
            attrValue += source[i];
            step();
          }
          if (i < n) step();
        } else {
          while (i < n && !/[\s/>]/.test(source[i] as string)) {
            attrValue += source[i];
            step();
          }
        }
      }
      if (attrName !== "") attrs.set(attrName, attrValue);
    }

    const local = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : name;
    if (local === "") continue;
    const node: MutableNode = { name: local, line: tagLine, attrs, children: [] };
    push(node);
    if (!selfClosing) stack.push(node);
  }
  return roots;
}

/** Image-presenting widget names — the `android-xml/image-no-label` set. Matched
 * on the bare widget name (`ImageView` / `ImageButton`); AppCompat/Material
 * variants are intentionally NOT image widgets here (they are controls, caught by
 * the control rule via their `clickable`/inherent-control status). */
const IMAGE_WIDGETS = new Set(["ImageView", "ImageButton"]);

/** Inherently-interactive control names — half of the `control-no-name` trigger
 * (the other half is `android:clickable="true"`). `Button`/`ImageButton` are
 * interactive regardless of an explicit `clickable` attribute. */
const INHERENT_CONTROLS = new Set(["Button", "ImageButton"]);

/** True when the element waives Android lint's `ContentDescription` check via its
 * OWN `tools:ignore`. The value is a comma/space-separated id list; `ContentDescription`
 * or `all` silences both rules. */
function ownSuppressed(attrs: ReadonlyMap<string, string>): boolean {
  const ignore = attrs.get("tools:ignore");
  if (ignore === undefined) return false;
  return ignore
    .split(/[\s,]+/)
    .some((id) => id === "ContentDescription" || id === "all");
}

/** An attribute is present and meaningful when set to a non-empty value. */
const has = (attrs: ReadonlyMap<string, string>, key: string): boolean => {
  const v = attrs.get(key);
  return v !== undefined && v !== "";
};

/** True when an image widget carries a text alternative OR is explicitly marked
 * decorative — either way it must NOT be flagged `image-no-label`. A
 * `contentDescription` (including the `@null` decorative sentinel) or an
 * `importantForAccessibility="no"` opt-out both satisfy 1.1.1. */
function imageLabeled(attrs: ReadonlyMap<string, string>): boolean {
  if (attrs.has("android:contentDescription")) return true;
  if (attrs.get("android:importantForAccessibility") === "no") return true;
  return false;
}

/** True when a control exposes its OWN accessible name — a `contentDescription`,
 * a visible `android:text`, or a `android:hint`. */
function controlNamedSelf(attrs: ReadonlyMap<string, string>): boolean {
  if (attrs.has("android:contentDescription")) return true;
  if (has(attrs, "android:text")) return true;
  if (has(attrs, "android:hint")) return true;
  // A design-time `tools:text` preview mirrors the text the control is populated
  // with at runtime — so a control carrying one is named, even with no static
  // `android:text` (the dominant pattern for runtime-bound labels/buttons).
  if (has(attrs, "tools:text")) return true;
  if (attrs.get("android:importantForAccessibility") === "no") return true;
  return false;
}

/** True when a node is a text-presenting widget — a `TextView` (any variant:
 * `AppCompatTextView`, a vendor `…TextView`, `CheckedTextView`) or an `EditText`.
 * Its presence in a clickable group's subtree means the group is announced by
 * that child's text even when the text is populated at runtime (no static
 * `android:text`), which is the dominant pattern in list-item rows. */
function isTextWidget(name: string): boolean {
  return name.endsWith("TextView") || name.endsWith("EditText");
}

/** True when ANY element in the subtree (excluding `node` itself) provides text a
 * screen reader would announce for the enclosing clickable group: a non-empty
 * `android:text`, a `contentDescription` that is not the `@null` decorative
 * sentinel, or a text-presenting widget (whose text is often set at runtime).
 * This is the descendant-climb that keeps a labeled child from making its
 * wrapping clickable container read as unnamed. */
function subtreeProvidesName(node: AndroidNode): boolean {
  for (const child of node.children) {
    if (isTextWidget(child.name)) return true;
    if (has(child.attrs, "android:text")) return true;
    if (has(child.attrs, "tools:text")) return true;
    const cd = child.attrs.get("android:contentDescription");
    if (cd !== undefined && cd !== "" && cd !== "@null") return true;
    if (subtreeProvidesName(child)) return true;
  }
  return false;
}

const isImageWidget = (name: string): boolean => IMAGE_WIDGETS.has(name);
const isControl = (node: AndroidNode): boolean =>
  INHERENT_CONTROLS.has(node.name) || node.attrs.get("android:clickable") === "true";

/** One raw rule hit before it is mapped onto the shared `Finding` shape. */
interface RawAndroidFinding {
  readonly file: string;
  readonly line: number;
  readonly ruleId: AndroidXmlRuleId;
}

/** Per-rule WCAG SC + the human-facing message, keyed by rule id. */
const RULE_META: Record<AndroidXmlRuleId, { wcag: readonly string[]; message: string }> = {
  "android-xml/image-no-label": {
    wcag: ["1.1.1"],
    message:
      'Image widget has no android:contentDescription — a screen reader announces nothing (set contentDescription, or contentDescription="@null" if purely decorative).',
  },
  "android-xml/control-no-name": {
    wcag: ["4.1.2"],
    message:
      "Interactive control exposes no accessible name — add android:contentDescription (or android:text, or a labeled child) so assistive tech can announce it.",
  },
};

/**
 * Walk one parsed layout tree and apply the two rules, accumulating raw hits.
 * `suppressedAbove` carries an ancestor's `tools:ignore="ContentDescription"`
 * down the subtree, matching Android lint's subtree-scoped suppression. An
 * `ImageButton` that is both an unlabeled image AND an unnamed control emits two
 * findings on the same line — once per rule.
 */
function walkTree(
  file: string,
  node: AndroidNode,
  suppressedAbove: boolean,
  out: RawAndroidFinding[],
): void {
  const suppressed = suppressedAbove || ownSuppressed(node.attrs);
  if (!suppressed) {
    if (isImageWidget(node.name) && !imageLabeled(node.attrs)) {
      out.push({ file, line: node.line, ruleId: "android-xml/image-no-label" });
    }
    if (isControl(node) && !controlNamedSelf(node.attrs) && !subtreeProvidesName(node)) {
      out.push({ file, line: node.line, ruleId: "android-xml/control-no-name" });
    }
  }
  for (const child of node.children) walkTree(file, child, suppressed, out);
}

/**
 * Apply the two Android-XML rules to one parsed file's root nodes. `file` is
 * carried through unchanged onto each finding so the caller controls the path
 * namespace.
 */
export function findingsForRoots(file: string, roots: readonly AndroidNode[]): RawAndroidFinding[] {
  const out: RawAndroidFinding[] = [];
  for (const root of roots) walkTree(file, root, false, out);
  return out;
}

/** Parse + rule a single layout source string — the unit-testable seam. */
export function findingsForSource(file: string, source: string): RawAndroidFinding[] {
  return findingsForRoots(file, parseAndroidLayout(source));
}

/**
 * The full output of an Android-XML scan, parallel to `SwiftScanResult`: the
 * findings plus the canonical `root` the collector scanned in (so the CLI renders
 * `relative(root, …)` against the exact namespace the findings carry) and a
 * `parseErrors` count for files that could not be read.
 */
export interface AndroidXmlScanResult {
  readonly root: string;
  readonly files: readonly string[];
  readonly findings: readonly Finding[];
  readonly parseErrors: number;
}

/**
 * Scan the `layout` resource `.xml` files under `dir` for static Android-XML
 * accessibility findings, in-process. Collects the layout files, parses each,
 * applies the two rules, and maps every raw hit onto a full {@link Finding} —
 * `provenance: "android-xml"`, the rule's WCAG SC, and the enforcement level the
 * governing `binclusive.json` assigns that SC (or `block` with no contract, the
 * historical default). One unreadable file is counted in `parseErrors` and the
 * scan continues — a single bad file never aborts the scan.
 */
export async function scanAndroidXml(dir: string): Promise<AndroidXmlScanResult> {
  const root = resolve(dir);
  const files = await collectAndroidLayoutFiles(root);

  const raw: RawAndroidFinding[] = [];
  let parseErrors = 0;
  for (const file of files) {
    let source: string;
    try {
      source = await readFile(file, "utf8");
    } catch {
      parseErrors++;
      continue;
    }
    raw.push(...findingsForSource(file, source));
  }

  // The contract that governs these files, found by walking up from them — same
  // package-up rule the other collectors use. With no `binclusive.json` every
  // finding is `block`.
  const contract = contractForFiles(raw.map((f) => f.file));

  const findings: Finding[] = raw.map((f) => ({
    file: f.file,
    line: f.line,
    ruleId: f.ruleId,
    message: RULE_META[f.ruleId].message,
    wcag: RULE_META[f.ruleId].wcag,
    enforcement: enforcementFor(RULE_META[f.ruleId].wcag, contract),
    provenance: "android-xml",
  }));

  return { root, files, findings, parseErrors };
}
