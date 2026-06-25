/**
 * A2 — the Android layout structural-absence rules (ADR 0006).
 *
 * The Android counterpart of `liquid-rules.ts` / the SwiftUI engine's rule set:
 * over the flat element list from `android-xml-ast.ts`, emit a {@link Finding} for
 * each view that is STRUCTURALLY missing an accessible name. Three rules, mirroring
 * the SwiftUI pair plus the form-label case:
 *
 *   android-xml/image-no-label   (1.1.1) — an `ImageView`/`ImageButton` with no
 *       `android:contentDescription`, not marked decorative.
 *   android-xml/control-no-name  (4.1.2) — an interactive view (`Button`,
 *       `ImageButton`, `android:onClick`, `android:clickable="true"`) with no
 *       text and no contentDescription — TalkBack announces nothing actionable.
 *   android-xml/editable-no-label (1.3.1) — an `EditText`-family field with neither
 *       `android:hint` nor a sibling `android:labelFor` pointing at it.
 *
 * Conservatism (the precision invariant): a rule fires only on a clear structural
 * absence. A decorative view (`android:importantForAccessibility="no"`) is never
 * flagged; a runtime-set name (a binding expression `@{…}`) counts as present, so a
 * data-bound description is not a false positive.
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
 * (`com.example.MyImageView` → `MyImageView`). */
function localTag(tag: string): string {
  const dot = tag.lastIndexOf(".");
  return dot === -1 ? tag : tag.slice(dot + 1);
}

/**
 * The value of an attribute by its LOCAL name, ignoring the namespace prefix —
 * `localAttr(el, "contentDescription")` matches `android:contentDescription` (or any
 * prefix). Prefers the canonical `android:` spelling when both exist.
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

/** Explicitly removed from the a11y tree → never flag (the Android `decorative`). */
function isDecorative(el: XmlElement): boolean {
  return localAttr(el, "importantForAccessibility") === "no";
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

/**
 * Run the structural-absence rules over one parsed layout's elements. The
 * `labelFor` cross-reference is resolved file-locally first (every id another view
 * labels), so an `EditText` named by a sibling label is not flagged.
 */
export function runAndroidXmlRules(
  elements: readonly XmlElement[],
  ctx: AndroidXmlRuleContext,
): Finding[] {
  const labelledIds = new Set<string>();
  for (const el of elements) {
    const target = idTarget(localAttr(el, "labelFor"));
    if (target !== undefined) labelledIds.add(target);
  }

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
  for (const el of elements) {
    if (isDecorative(el)) continue;
    const tag = localTag(el.tag);

    if (IMAGE_TAGS.has(tag) && !hasValue(el, "contentDescription")) {
      findings.push(
        make(
          "android-xml/image-no-label",
          `<${el.tag}> has no android:contentDescription — TalkBack announces nothing. Add android:contentDescription="…", or mark it decorative with android:importantForAccessibility="no".`,
          el,
        ),
      );
    }

    if (isInteractive(el) && !hasValue(el, "text") && !hasValue(el, "contentDescription")) {
      findings.push(
        make(
          "android-xml/control-no-name",
          `<${el.tag}> is interactive but has no accessible name — TalkBack reads no actionable label. Add android:contentDescription="…" (or android:text="…" for a text control).`,
          el,
        ),
      );
    }

    if (EDIT_TAGS.has(tag)) {
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
  }
  return findings;
}
