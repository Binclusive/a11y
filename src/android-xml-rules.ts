/**
 * A2 — the Android layout structural-absence rules (ADR 0006).
 *
 * The Android counterpart of `liquid-rules.ts` / the SwiftUI engine's rule set: walk
 * the element TREE from `android-xml-ast.ts` and emit a {@link Finding} for each view
 * that is STRUCTURALLY missing an accessible name. Three rules, mirroring the SwiftUI
 * pair plus the form-label case:
 *
 *   android-xml/image-no-label   (1.1.1) — an `ImageView`/`ImageButton` with no
 *       `android:contentDescription`, not decorative, not suppressed.
 *   android-xml/control-no-name  (4.1.2) — an interactive view (`Button`,
 *       `ImageButton`, `android:onClick`, `android:clickable="true"`) that supplies
 *       no name ANYWHERE in its subtree — TalkBack announces nothing actionable.
 *   android-xml/editable-no-label (1.3.1) — an `EditText`-family field with neither
 *       `android:hint` nor a sibling `android:labelFor` pointing at it.
 *
 * Conservatism (the precision invariant — validated against a real corpus, NewPipe):
 *   - `android:importantForAccessibility="no"` (the element) and `"noHideDescendants"`
 *     (the element + its subtree) are removed from the a11y tree → never flagged.
 *   - `tools:ignore="ContentDescription"` (and `…="all"`) is an EXPLICIT developer
 *     suppression of exactly this lint — honored like the React side honors
 *     `aria-hidden` / eslint-disable. It applies to the element and its subtree.
 *   - A clickable CONTAINER is named by its descendants, so `control-no-name` looks
 *     DOWN the subtree for a name before firing (the analog of the SwiftUI climb).
 *   - A data-bound name (`@{…}`) counts as present — a runtime name is not absence.
 */

import type { XmlElement } from "./android-xml-ast";
import type { EnforcementLevel } from "./config-scan";
import type { Finding } from "./core";

/** WCAG SC for each Android XML rule id — the bridge that lets a finding match the
 * corpus by SC, exactly like `RULE_WCAG` in `liquid-rules.ts`. */
const RULE_WCAG: Record<string, readonly string[]> = {
  "android-xml/image-no-label": ["1.1.1"],
  "android-xml/control-no-name": ["4.1.2"],
  "android-xml/editable-no-label": ["1.3.1"],
};

/** WCAG SCs for an Android XML rule id (empty if unknown — never throws). */
export function wcagForAndroidXmlRule(ruleId: string): readonly string[] {
  return RULE_WCAG[ruleId] ?? [];
}

/** What the rule pass needs from the file walk: the path + the enforcement level to
 * stamp (the collector overrides it per-finding from the contract, as Liquid does). */
export interface AndroidXmlRuleContext {
  readonly file: string;
  readonly enforcement: EnforcementLevel;
}

const IMAGE_TAGS = new Set(["ImageView", "ImageButton"]);
const EDIT_TAGS = new Set([
  "EditText",
  "AutoCompleteTextView",
  "MultiAutoCompleteTextView",
  "TextInputEditText",
]);

/** The local tag name, dropping any fully-qualified package on a custom view
 * (`androidx.appcompat.widget.AppCompatImageButton` → `AppCompatImageButton`). */
function localTag(tag: string): string {
  const dot = tag.lastIndexOf(".");
  return dot === -1 ? tag : tag.slice(dot + 1);
}

/**
 * The value of an attribute by its LOCAL name, ignoring the namespace prefix —
 * `localAttr(el, "contentDescription")` matches `android:contentDescription`,
 * `localAttr(el, "ignore")` matches `tools:ignore`. Prefers the canonical `android:`
 * spelling when both exist.
 */
function localAttr(el: XmlElement, local: string): string | undefined {
  const canonical = el.attrs.get(`android:${local}`);
  if (canonical !== undefined) return canonical;
  for (const [key, value] of el.attrs) {
    const colon = key.indexOf(":");
    const name = colon === -1 ? key : key.slice(colon + 1);
    if (name === local) return value;
  }
  return undefined;
}

/** Is the attribute a present, non-empty value? A data-binding expression (`@{…}`)
 * counts as present — the name is supplied at runtime, so flagging it would be a
 * false positive (the conservatism guard). */
function hasValue(el: XmlElement, local: string): boolean {
  const v = localAttr(el, local);
  return v !== undefined && v.trim() !== "";
}

/** Does the element (or, for `noHideDescendants`, an ancestor that set the inherited
 * flag) sit outside the a11y tree? `"no"` hides the element itself; the subtree case
 * is carried in {@link Inherited.hidden}. */
function selfHidden(el: XmlElement, inheritedHidden: boolean): boolean {
  return inheritedHidden || localAttr(el, "importantForAccessibility") === "no";
}

/** Does `android:importantForAccessibility="noHideDescendants"` here remove the whole
 * subtree from the a11y tree (inherited downward)? */
function hidesDescendants(el: XmlElement): boolean {
  return localAttr(el, "importantForAccessibility") === "noHideDescendants";
}

/** Does `tools:ignore` on this element suppress the missing-contentDescription lint
 * (the `ContentDescription` id, or the blanket `all`)? Applies to the subtree. */
function ignoresContentDescription(el: XmlElement): boolean {
  return ignoreList(el).some((id) => id === "ContentDescription" || id === "all");
}

/** The comma-separated `tools:ignore` lint ids on this element (trimmed). */
function ignoreList(el: XmlElement): string[] {
  const v = localAttr(el, "ignore");
  if (v === undefined) return [];
  return v.split(",").map((s) => s.trim());
}

/** A view that is operable: a button, or made clickable in the layout. */
function isInteractive(el: XmlElement): boolean {
  const tag = localTag(el.tag);
  if (tag === "Button" || tag === "ImageButton") return true;
  if (localAttr(el, "onClick") !== undefined) return true;
  return localAttr(el, "clickable") === "true";
}

/** The bare id from an `@+id/foo` / `@id/foo` / `@android:id/foo` reference. */
function idTarget(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const slash = value.lastIndexOf("/");
  return slash === -1 ? value : value.slice(slash + 1);
}

/** Does `el` or ANY descendant carry a non-empty name (text / contentDescription)?
 * This is what makes a clickable container safe: TalkBack reads the descendants'
 * text, so the container is not nameless. Stops at a `noHideDescendants` subtree
 * (those descendants are not announced). */
function subtreeSuppliesName(el: XmlElement, hidden: boolean): boolean {
  if (selfHidden(el, hidden)) return false;
  if (hasValue(el, "text") || hasValue(el, "contentDescription")) return true;
  const childHidden = hidden || hidesDescendants(el);
  for (const child of el.children) {
    if (subtreeSuppliesName(child, childHidden)) return true;
  }
  return false;
}

/** Carried down the tree: whether an ancestor hid the subtree, suppressed the
 * contentDescription lint over it, or is a `TextInputLayout` (which owns the label
 * for the `EditText` it wraps — statically or at runtime). */
interface Inherited {
  readonly hidden: boolean;
  readonly cdSuppressed: boolean;
  readonly inTextInputLayout: boolean;
}

/**
 * Run the structural-absence rules over one parsed layout's element tree. The
 * `labelFor` cross-reference is resolved file-locally first (every id another view
 * labels), so an `EditText` named by a sibling label is not flagged.
 */
export function runAndroidXmlRules(
  roots: readonly XmlElement[],
  ctx: AndroidXmlRuleContext,
): Finding[] {
  const labelledIds = new Set<string>();
  const collectLabels = (el: XmlElement): void => {
    const target = idTarget(localAttr(el, "labelFor"));
    if (target !== undefined) labelledIds.add(target);
    for (const child of el.children) collectLabels(child);
  };
  for (const root of roots) collectLabels(root);

  const make = (ruleId: string, message: string, el: XmlElement): Finding => ({
    file: ctx.file,
    line: el.line,
    ruleId,
    message,
    wcag: RULE_WCAG[ruleId] ?? [],
    enforcement: ctx.enforcement,
    provenance: "android-xml",
  });

  const findings: Finding[] = [];

  const walk = (el: XmlElement, inh: Inherited): void => {
    const hidden = selfHidden(el, inh.hidden);
    const cdSuppressed = inh.cdSuppressed || ignoresContentDescription(el);
    const tag = localTag(el.tag);

    // Rules that hinge on contentDescription are skipped when the element is hidden
    // or the dev suppressed that lint over this subtree.
    if (!hidden && !cdSuppressed) {
      if (IMAGE_TAGS.has(tag) && !hasValue(el, "contentDescription")) {
        findings.push(
          make(
            "android-xml/image-no-label",
            `<${el.tag}> has no android:contentDescription — TalkBack announces nothing. Add android:contentDescription="…", or mark it decorative with android:importantForAccessibility="no".`,
            el,
          ),
        );
      }
      // A control with no name ANYWHERE in its subtree. The descendant look is what
      // stops a clickable row (named by its child TextView) from being a false positive.
      if (isInteractive(el) && !subtreeSuppliesName(el, inh.hidden)) {
        findings.push(
          make(
            "android-xml/control-no-name",
            `<${el.tag}> is interactive but supplies no accessible name (nothing in its subtree has text or a contentDescription) — TalkBack reads no actionable label. Add android:contentDescription="…", or a labelled child.`,
            el,
          ),
        );
      }
    }

    // A field wrapped in a Material TextInputLayout is labelled by that parent (its
    // floating hint, set statically or in code) — stay opaque rather than flag it,
    // the conservatism the real corpus (AntennaPod) demanded.
    if (
      !hidden &&
      !inh.inTextInputLayout &&
      EDIT_TAGS.has(tag) &&
      !ignoreList(el).some((id) => id === "LabelFor" || id === "all")
    ) {
      const id = idTarget(localAttr(el, "id"));
      const labelled = id !== undefined && labelledIds.has(id);
      if (!hasValue(el, "hint") && !labelled) {
        findings.push(
          make(
            "android-xml/editable-no-label",
            `<${el.tag}> has no label — neither android:hint nor a <… android:labelFor> points to it, so TalkBack reads an unlabeled field. Add android:hint="…", or a label View with android:labelFor.`,
            el,
          ),
        );
      }
    }

    const childInh: Inherited = {
      hidden: inh.hidden || hidesDescendants(el),
      cdSuppressed,
      inTextInputLayout: inh.inTextInputLayout || tag === "TextInputLayout",
    };
    for (const child of el.children) walk(child, childInh);
  };

  for (const root of roots) walk(root, { hidden: false, cdSuppressed: false, inTextInputLayout: false });
  return findings;
}
