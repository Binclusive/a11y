/**
 * Unity label resolution — the core precision rule for the Unity producer (#70, child
 * of #66, ADR 0004). The Unity analog of the Liquid present/dynamic/absent attribute
 * seam (`.patterns/liquid-html-parser/attributes.md`, `src/enforce.ts`).
 *
 * A uGUI interactive widget (Button / Toggle) carries its accessible label NOT on
 * itself but on a **child** `TextMeshProUGUI` / `Text`'s `m_text` field. That same
 * child very often also carries a `LocalizeStringEvent` (Unity Localization package)
 * whose `m_UpdateString` calls `set_text` on the sibling TMP at runtime, overwriting
 * `m_text` from a localization table (`m_StringReference.m_TableReference` /
 * `m_TableEntryReference`). So the static `m_text` a file-reader sees is, for a
 * localized widget, a placeholder (often a single char like `X`) — the visible label
 * is injected at runtime and is **not statically knowable**.
 *
 * The label therefore has **three** static states, not a boolean:
 *
 *   - `Static(text)` — `m_text` is the real label: a text-bearing child exists and no
 *     enabled LocalizeStringEvent with a real table reference overrides it.
 *   - `Dynamic`      — an ENABLED LocalizeStringEvent with a non-empty table reference
 *     is present on the text child: the label is runtime-injected. Treat it OPAQUE —
 *     do NOT flag as missing (the no-false-positive lock, story 3). This is the
 *     precision crux: a naive `m_text`-only read false-positives the *majority* of
 *     localized buttons in a real Unity project, the failure mode that gets an a11y
 *     tool uninstalled (the precision invariant in `CLAUDE.md`).
 *   - `Absent`       — no text-bearing child at all: the genuine missing-label finding
 *     (story 4).
 *
 * The precision invariant the whole resolver lives by holds here: resolve to the
 * correct state or stay opaque (`Dynamic`), never produce a false `Absent` on a
 * localized widget.
 *
 * Why this module re-reads the raw source for the LocalizeStringEvent fields: the L1
 * AST (`unity-ast.ts`) captures the field surface the *graph* needs (`m_text`,
 * `m_Script` guid, `m_Children`) but not the LocalizeStringEvent's `m_Enabled` /
 * nested `m_StringReference` sub-block. Rather than widen the shared AST (this is a
 * self-contained rule, #70; integration is a later child), the dynamic-detection
 * fields are read here, keyed by the component's `&fileID`, from the same source the
 * graph was parsed from.
 */

import {
  childGameObjects,
  resolveComponentIdentity,
  type FileId,
  type UnityComponent,
  type UnityGameObject,
  type UnityGraph,
} from "./unity-ast";
import type { UnityWidgetKind } from "./unity-guid-registry";

/** The serialized class name of the runtime-localization component whose presence +
 * enabled + table reference makes a label dynamic. */
const LOCALIZE_STRING_EVENT_TYPE = "LocalizeStringEvent";

/** The stable built-in guid of `LocalizeStringEvent` (Unity Localization package),
 * grounded against the #70 corpus anchor `UnityTechnologies/open-project-1` @ 608eac98
 * (`Tab_Item.prefab`, `GenericButton.prefab`, `Button.prefab`). Identity is keyed on
 * either the type name or this guid — tolerant of which the serializer emitted. */
export const LOCALIZE_STRING_EVENT_GUID = "56eb0353ae6e5124bb35b17aff880f16";

/** The widget kinds that bear an accessible-name `m_text` — uGUI legacy `Text` and
 * `TextMeshProUGUI`. A text widget serializes as a generic `MonoBehaviour` whose
 * IDENTITY is its `m_Script` guid, so we resolve it via the built-in registry (which
 * maps both to `host: "text"`), never by the serialized type name (which is just
 * "MonoBehaviour"). This keeps the seam grounded on the same guid table the rest of
 * the resolver uses. */
const TEXT_BEARING_WIDGETS = new Set<UnityWidgetKind>([
  "TextMeshProUGUI",
  "Text",
]);

/**
 * The 3-state label resolution result — a discriminated union, never a boolean. This
 * mirrors the Liquid attribute seam: `Static` ≙ present literal, `Dynamic` ≙
 * runtime-injected (opaque, not flagged), `Absent` ≙ genuinely missing (flagged).
 */
export type UnityLabel =
  | { readonly kind: "static"; readonly text: string }
  | { readonly kind: "dynamic" }
  | { readonly kind: "absent" };

/** Constructors — keep call sites total and the union the single shape callers match. */
export const UnityLabel = {
  static: (text: string): UnityLabel => ({ kind: "static", text }),
  dynamic: (): UnityLabel => ({ kind: "dynamic" }),
  absent: (): UnityLabel => ({ kind: "absent" }),
} as const;

/**
 * Resolve the accessible label of an interactive widget GameObject to its 3-state value.
 *
 * Walks `m_Children` (one level, via the transform indirection `childGameObjects`
 * resolves) looking for a text-bearing child component (`TextMeshProUGUI` / `Text`):
 *
 *   1. No text-bearing child found anywhere in the children → `Absent`.
 *   2. A text-bearing child whose GameObject also carries an ENABLED
 *      LocalizeStringEvent with a non-empty table reference → `Dynamic` (opaque).
 *   3. Otherwise → `Static(m_text)` (the static literal is the label; an empty/missing
 *      `m_text` with no localization is `Static("")`, still a resolved label state,
 *      not absent — absence is *no text component at all*).
 *
 * `source` is the same Force-Text source the `graph` was parsed from; it is read only
 * for the LocalizeStringEvent fields the L1 AST does not capture (`m_Enabled`, the
 * nested `m_StringReference`), keyed by each component's `&fileID`.
 *
 * @returns the 3-state `UnityLabel`. Never throws — a malformed sub-block degrades to
 *          the conservative state (a non-readable LocalizeStringEvent is treated as not
 *          dynamic, so the visible `m_text` governs).
 */
export function resolveUnityLabel(
  graph: UnityGraph,
  widget: UnityGameObject,
  source: string,
): UnityLabel {
  const localizeEvents = readLocalizeStringEvents(source);

  // First text-bearing child wins (a uGUI widget has a single label child by
  // convention; if several exist, the first in hierarchy order is the label).
  for (const child of childGameObjects(graph, widget)) {
    const textComponent = child.components.find((c) => isTextBearing(graph, c));
    if (!textComponent) continue;

    // Dynamic check: does THIS text child's GameObject carry an enabled
    // LocalizeStringEvent with a real table reference? If so the label is
    // runtime-injected → opaque, do not flag.
    const hasDynamicLabel = child.components.some((component) => {
      if (!isLocalizeStringEvent(component)) return false;
      const fields = localizeEvents.get(component.fileId);
      return fields != null && fields.enabled && fields.hasTableReference;
    });
    if (hasDynamicLabel) return UnityLabel.dynamic();

    return UnityLabel.static(textComponent.text ?? "");
  }

  return UnityLabel.absent();
}

/** A component carries an accessible-name `m_text` (uGUI `Text` / TMP). Resolved via
 * the built-in-widget guid registry — a text widget serializes as a generic
 * `MonoBehaviour`, so its identity is its `m_Script` guid, not its type name. */
function isTextBearing(graph: UnityGraph, component: UnityComponent): boolean {
  const identity = resolveComponentIdentity(graph, component);
  return identity.kind === "widget" && TEXT_BEARING_WIDGETS.has(identity.widget);
}

/** A component is a `LocalizeStringEvent` — keyed on the built-in guid (robust to
 * Unity's generic `MonoBehaviour` type name) or, defensively, an explicit type name. */
function isLocalizeStringEvent(component: UnityComponent): boolean {
  return (
    component.scriptGuid === LOCALIZE_STRING_EVENT_GUID ||
    component.typeName === LOCALIZE_STRING_EVENT_TYPE
  );
}

/** The dynamic-detection fields of one LocalizeStringEvent, not captured by the L1 AST. */
interface LocalizeStringEventFields {
  /** `m_Enabled: 1` — a disabled event injects nothing at runtime (the base prefab's
   * shape: disabled + empty reference → the static `m_text` governs). */
  readonly enabled: boolean;
  /** A non-empty table reference — either a non-empty `m_TableCollectionName` (a name
   * or a `GUID:<hex>` form) OR a non-zero `m_KeyId` OR a non-empty `m_Key`. Any one is
   * a real runtime label source. The base prefab's empty-on-all-three reference is NOT
   * a real reference, so disabled-or-empty ⇒ not dynamic. */
  readonly hasTableReference: boolean;
}

const HEADER_RE = /^--- !u!(\d+) &(\d+)/;
const ENABLED_RE = /^\s*m_Enabled:\s*(\d+)/;
const TABLE_COLLECTION_RE = /^\s*m_TableCollectionName:\s*(.*)$/;
const KEY_ID_RE = /^\s*m_KeyId:\s*(\d+)/;
const KEY_RE = /^\s*m_Key:\s*(.*)$/;
const GUID_LINE_RE = /guid:\s*([0-9a-fA-F]{32})/;

/**
 * Read every LocalizeStringEvent document's dynamic-detection fields from the raw
 * Force-Text source, indexed by the component's `&fileID`. Line-oriented over the same
 * `--- !u!N &id` document blocks the L1 AST splits on; we only scan blocks whose
 * `m_Script` guid is the LocalizeStringEvent guid, and read the three reference fields
 * plus `m_Enabled`. Tolerant: a malformed block simply contributes no entry (treated
 * as not-dynamic by the caller — the conservative direction).
 */
function readLocalizeStringEvents(source: string): Map<FileId, LocalizeStringEventFields> {
  const out = new Map<FileId, LocalizeStringEventFields>();
  const lines = source.split("\n");

  let currentFileId: FileId | null = null;
  let block: string[] = [];

  const flush = () => {
    if (currentFileId == null) return;
    const isLocalize = block.some((l) => {
      const m = /^\s*m_Script:.*$/.test(l) ? GUID_LINE_RE.exec(l) : null;
      return m != null && m[1]!.toLowerCase() === LOCALIZE_STRING_EVENT_GUID;
    });
    if (isLocalize) {
      out.set(currentFileId, parseFields(block));
    }
  };

  for (const line of lines) {
    const header = HEADER_RE.exec(line);
    if (header) {
      flush();
      currentFileId = header[2]!;
      block = [];
    } else if (currentFileId != null) {
      block.push(line);
    }
  }
  flush();

  return out;
}

/** Extract `m_Enabled` + whether any table reference is non-empty from one block. */
function parseFields(lines: readonly string[]): LocalizeStringEventFields {
  let enabled = false;
  let hasTableReference = false;

  for (const line of lines) {
    const enabledMatch = ENABLED_RE.exec(line);
    if (enabledMatch) {
      enabled = enabledMatch[1] === "1";
      continue;
    }
    const collectionMatch = TABLE_COLLECTION_RE.exec(line);
    if (collectionMatch && stripComment(collectionMatch[1] ?? "") !== "") {
      hasTableReference = true;
      continue;
    }
    const keyIdMatch = KEY_ID_RE.exec(line);
    if (keyIdMatch && keyIdMatch[1] !== "0") {
      hasTableReference = true;
      continue;
    }
    const keyMatch = KEY_RE.exec(line);
    if (keyMatch && stripComment(keyMatch[1] ?? "") !== "") {
      hasTableReference = true;
    }
  }

  return { enabled, hasTableReference };
}

/** Strip a trailing YAML comment + surrounding whitespace from a scalar value. */
function stripComment(raw: string): string {
  return raw.replace(/\s+#.*$/, "").trim();
}
