/**
 * The Unity built-in-widget GUID registry — the Unity analog of `registry.ts`'s
 * known-library wrapper→host table, the deterministic fast path for component
 * identity (issue #71, ADR 0004).
 *
 * Unity serializes a `MonoBehaviour`'s type as an `m_Script: {guid: <32-hex>}`
 * reference into the script's `.meta`. For **built-in** uGUI/TMP components those
 * guids are *stable Unity constants — identical in every project* (the engine ships
 * them), so built-in widget identity is a pure table lookup here, never per-project
 * `.meta` resolution. (`.meta` resolution for *project-custom* MonoBehaviours is a
 * later capability and explicitly out of scope for this slice — ADR 0004.)
 *
 * The precision invariant the whole resolver lives by holds at this seam: a guid in
 * the table resolves to the correct built-in widget; a guid NOT in the table (a
 * custom MonoBehaviour) resolves to `undefined` here, which the caller treats as
 * OPAQUE — it is never mapped to a wrong widget. Coverage is pure DATA: adding a
 * built-in widget is a new row, never a code change (the `registry.ts` discipline).
 */

/** The accessibility-relevant widget kinds we resolve a built-in guid to. The
 * `host` is the WAI-ARIA/HTML host the structural-absence rules (later children)
 * will reason about — a Button is interactive (`button`), an Image is `img`, a text
 * widget carries the accessible name (`text`). */
export type UnityWidgetKind =
  | "Button"
  | "Image"
  | "RawImage"
  | "TextMeshProUGUI"
  | "Text"
  | "Toggle";

/** One built-in widget the registry resolves. `guid` is the stable Unity engine
 * constant (lowercase 32-hex); `widget` is its kind; `host` is the host element the
 * rules map it to (the bridge to the existing engine's host vocabulary). */
export interface UnityBuiltinWidget {
  /** The stable cross-project Unity engine guid (lowercase, 32 hex chars). */
  readonly guid: string;
  /** The widget kind this guid denotes. */
  readonly widget: UnityWidgetKind;
  /** The accessibility host the structural-absence rules reason over. */
  readonly host: "button" | "img" | "text";
}

/**
 * The seed table of built-in uGUI/TMP widget guids.
 *
 * Provenance — every row is grounded, not guessed (the precision invariant forbids a
 * speculative guid mapping a custom component to a wrong host):
 *   - Button / Image / TextMeshProUGUI — the three verified constants on issue #71
 *     (real-corpus evidence, ADR 0004 §Context).
 *   - Text (legacy uGUI) / Toggle — verified against the #71 corpus anchor
 *     (`UnityTechnologies/open-project-1` @ 608eac98) by their distinctive serialized
 *     fields (`m_FontData`/`m_Text` for Text; `m_IsOn`/`m_Group` for Toggle).
 *
 * Slider, Dropdown, InputField, etc. are deliberately omitted until a row can be
 * grounded the same way — an unverified guid would defeat the precision invariant.
 * Extend by appending a verified row.
 */
export const UNITY_BUILTIN_GUIDS: readonly UnityBuiltinWidget[] = [
  { guid: "4e29b1a8efbd4b44bb3f3716e73f07ff", widget: "Button", host: "button" },
  { guid: "fe87c0e1cc204ed48ad3b37840f39efc", widget: "Image", host: "img" },
  { guid: "f4688fdb7df04437aeb418b961361dc5", widget: "TextMeshProUGUI", host: "text" },
  { guid: "5f7201a12d95ffc409449d95f23cf332", widget: "Text", host: "text" },
  { guid: "9085046f02f69544eb97fd06b6048fe2", widget: "Toggle", host: "button" },
];

/** Guid → widget index, built once. Keys are normalized (lowercased) so a lookup is
 * insensitive to the casing Unity happens to emit. */
const BY_GUID: ReadonlyMap<string, UnityBuiltinWidget> = new Map(
  UNITY_BUILTIN_GUIDS.map((w) => [w.guid, w] as const),
);

/**
 * Resolve an `m_Script` guid to its built-in widget, or `undefined` if it is not a
 * known built-in. `undefined` is the OPAQUE signal: the caller must treat an
 * unresolved guid as opaque and never map it to a host — the precision invariant
 * (map to the correct built-in or stay opaque; never wrong-host). Tolerant of
 * surrounding whitespace and casing so a raw serialized value resolves directly.
 */
export function resolveWidgetGuid(guid: string): UnityBuiltinWidget | undefined {
  return BY_GUID.get(guid.trim().toLowerCase());
}
