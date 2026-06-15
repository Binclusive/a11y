import ts from "typescript";
import { enforcementFor } from "./config-scan";
import type { Contract, Declarations } from "./contract";
import type { Finding } from "./core";
import {
  isIconLibrary,
  isRouterLinkControl,
  isToggleRole,
  lookupGuaranteed,
  lookupRegistry,
} from "./registry";
import type { ComponentResolution } from "./resolve-components";
import { collectLocalImports, type ImportBinding } from "./source-trace";
import { ariaHiddenLineRanges, transInjectedLineRanges } from "./suppression-ranges";

/**
 * The enforce check: corpus-driven, call-site CONTENT rules.
 *
 * The structural jsx-a11y pass (see `core.ts`) only fires on elements it can see
 * as a host — intrinsic tags, and wrappers it resolved to a host primitive. A
 * design-system `<Button>` used icon-only (`<Button><TrashIcon/></Button>`,
 * no accessible name) is a real 4.1.2 bug that pass MISSES whenever the Button
 * is opaque/trusted: "trusted" guarantees the library's INTERNAL structure, not
 * the content the app passes in. That false reassurance is exactly the recall
 * gap this check closes.
 *
 * Each rule MIRRORS a distilled corpus pattern (see `data/corpus/patterns-*.json`):
 *   - button / icon-button : 4.1.2-button-no-name
 *   - image                : 1.1.1 image-no-alt family
 *   - link                 : 2.4.4-link-no-name
 *   - dialog / modal       : 4.1.2 (+ 1.3.1) nameless-dialog
 *   - input / field        : 1.3.1 / 3.3.2 form-control-no-name
 *
 * It recognizes the control TYPE at the call site — by resolved host, by the
 * registry, or by a conservative NAME heuristic — and so works on opaque/trusted
 * components too (recognized by name/registry, never needing their source).
 *
 * Conservatism is the whole discipline. A rule fires ONLY when the app-owned
 * content is STATICALLY, CLEARLY missing. The moment content could be supplied
 * dynamically — a `{...props}` spread, a computed child, a non-literal attribute
 * — the element is "incomplete", not a violation, and is left alone. That line
 * is what keeps the check from reintroducing false positives. Uncertain → skip.
 */

/** A recognized call-site control type, each mapping to one corpus rule family. */
export type ControlType = "button" | "icon-button" | "link" | "image" | "dialog" | "input";

/** Inputs the enforce pass needs from the surrounding scan. */
export interface EnforceContext {
  /**
   * The per-component resolution outcomes from {@link resolveComponents} —
   * each carrying the wrapper's NAME, its import MODULE, and the host it
   * resolved to (or `null` for opaque). The enforce pass recognizes a resolved
   * host only when the call site's import MODULE matches the module that host
   * was resolved from (see {@link buildResolvedHosts} / {@link classify}).
   *
   * This is what kills the module-blind name collision: jsx-a11y's flat
   * `name -> host` map (what it ACTUALLY lints with) is keyed by leaf name only,
   * so a MUI `<TextField>` (registry -> `input`) anywhere makes EVERY `<TextField>`
   * read as an input — including a react-admin display `<TextField source=…>`,
   * which renders a `<span>`, not a control. Scoping the host lookup to
   * `(name, module)` means the react-admin field (opaque from `react-admin`)
   * never inherits the MUI field's host.
   */
  readonly resolutions: readonly ComponentResolution[];
  /** The governing contract's declarations, or `null` zero-config. */
  readonly declarations: Declarations | null;
  /** The governing contract, for per-finding enforcement level. */
  readonly contract: Contract | null;
}

/**
 * A module-aware resolved-host lookup, keyed by `"<jsx-name>@<module>"` — the
 * SAME identity the call site reconstructs from `(tagName, binding.module)`.
 * Only components that resolved to a concrete host are included; opaque ones
 * are absent, so a call site whose import is the opaque one finds nothing here
 * and falls through to the registry / name heuristic (or to "not a control").
 *
 * This is the module-scoped replacement for jsx-a11y's flat, leaf-keyed map:
 * two different components that share a leaf name (MUI `TextField` vs
 * react-admin `TextField`) get DISTINCT keys, so one can never lend its host to
 * the other.
 */
/**
 * A resolved host plus the explicit toggle `role` it carries (if any) and
 * whether the wrapper renders the host its OWN static accessible name internally
 * (an `sr-only` span, a literal `aria-label`, or static text — captured by the
 * trace). A host with `rendersOwnName` is named even when the call site looks
 * empty, so the no-name check skips it.
 */
interface ResolvedHost {
  readonly host: string;
  readonly role: string | null;
  readonly rendersOwnName: boolean;
}

function buildResolvedHosts(
  resolutions: readonly ComponentResolution[],
): ReadonlyMap<string, ResolvedHost> {
  const out = new Map<string, ResolvedHost>();
  for (const r of resolutions) {
    if (r.host !== null) {
      out.set(`${r.name}@${r.module}`, {
        host: r.host,
        role: r.role,
        rendersOwnName: r.rendersOwnName,
      });
    }
  }
  return out;
}

/**
 * How CONFIDENTLY a control was recognized — the lever that keeps the name
 * heuristic from reintroducing false positives:
 *
 *   - `host` — recognized via a resolved/registry HOST (`button`/`a`/`img`/
 *     `input`). We have PROVEN this is a thin wrapper that forwards props to a
 *     single primitive (the tracer/registry/declaration established it), so its
 *     content at the call site IS the control's content. A self-closing one with
 *     no name is genuinely nameless.
 *   - `name` — recognized only by a NAME suffix (`QuickCreateButton`,
 *     `SearchInput`). We have NOT seen inside it; it may render its own label.
 *     Trustworthy ONLY when we can see its CHILDREN are empty-or-icon (a visible
 *     container). A self-closing name-only component is opaque — skip it.
 *
 *     GATED ON A GUARANTEED LIBRARY. The name path fires ONLY when the
 *     component's import module is a known design system
 *     (`lookupGuaranteed(module) !== null` — Radix/MUI/Chakra/Mantine/React
 *     Aria). Within such a library, an opaque `Button`/`IconButton`/`ActionIcon`
 *     reliably IS a button: the library owns the contract. From an UNRECOGNIZED
 *     module (`react-admin`, a customer's own `react-admin`-style re-export), a
 *     bare `Button` is a GUESS, not evidence — react-admin's `Button` takes its
 *     name from a `label=` prop and renders no children, so a name-only match
 *     mass-false-positives. Unrecognized-module bare names therefore never reach
 *     the name path; they stay unrecognized (the conservative default). A
 *     component the tracer resolved to a real host is `host`-strength and is
 *     unaffected — only imported-from-unknown-module bare names lose firing.
 */
type Strength = "host" | "name";

/** A recognized control: its type plus how confidently it was recognized. */
interface Recognized {
  readonly type: ControlType;
  readonly strength: Strength;
}

/**
 * Conservative NAME heuristics: a capitalized JSX name that, by convention,
 * names a control of a given type even when the component is opaque. Matched on
 * the LEAF name (`Foo.Button` -> `Button`) and only when the name IS or ENDS
 * WITH the keyword (so `IconButton`, `PrimaryButton`, `SubmitButton` all read as
 * buttons, but `ButtonGroup` does not — a group is not itself a control).
 *
 * Order matters: `IconButton` must classify as `icon-button` (a stricter rule)
 * before the broader `Button` suffix claims it, so icon-button keywords precede
 * button keywords.
 *
 * `ActionIcon` is Mantine's icon-only button (its whole purpose is an icon with
 * NO text, named by `aria-label`). It carries no `Button` suffix, so it needs
 * its own keyword; it reads as `icon-button` so the stricter icon-only rule
 * applies. It is only ever consulted within a guaranteed library (the name path
 * is gated — see {@link Strength}), so it can't mass-fire on an app that happens
 * to name something `ActionIcon`.
 *
 * INPUTS ARE DELIBERATELY ABSENT. An input's accessible name usually comes from
 * a SIBLING/ANCESTOR label (`<label for>`, `<FormLabel>`, `Box as="label"`) that
 * is invisible at the call site — so a name-heuristic'd `*Input`/`*Field` (the
 * react-hook-form `FormField` controller, cmdk `CommandInput`, a wrapped search
 * box) cannot be PROVEN nameless and would be a false positive. Inputs are only
 * recognized via a real input HOST (registry/resolved), never by name.
 */
export const NAME_HEURISTICS: ReadonlyArray<{
  readonly type: ControlType;
  readonly keyword: string;
}> = [
  { type: "icon-button", keyword: "ActionIcon" },
  { type: "icon-button", keyword: "IconButton" },
  { type: "button", keyword: "Button" },
  { type: "link", keyword: "Link" },
  { type: "image", keyword: "Image" },
  { type: "dialog", keyword: "Dialog" },
  { type: "dialog", keyword: "Modal" },
];

/** Host primitive -> the control type the enforce rules treat it as. */
const HOST_TO_TYPE: Readonly<Record<string, ControlType>> = {
  button: "button",
  a: "link",
  img: "image",
  input: "input",
  textarea: "input",
  select: "input",
};

/**
 * The native form-control intrinsics that get the input name-check directly —
 * not via a resolved wrapper. jsx-a11y would normally own a bare `<input>`, but
 * we don't run its `control-has-associated-label`, so an unlabeled native input
 * slips through every recognition path in {@link classify}. We recognize EXACTLY
 * these three lowercase tags and nothing else: a `<td>` / `<div>` is not a
 * control, which is precisely why react-doctor's `control-has-associated-label`
 * false-positives on layout cells and this never can.
 */
const NATIVE_FORM_CONTROLS: ReadonlySet<string> = new Set(["input", "select", "textarea"]);

/**
 * Native `<input>` `type` values that exempt it from the name check. submit /
 * button / reset are named by their `value`; hidden / image are not text-name-
 * bearing (an image input's name is alt's job); checkbox / radio are externally
 * labelled toggles, skipped exactly as {@link TOGGLE_NAMES} are. A DYNAMIC
 * `type={x}` is unknowable, so — uncertain → skip — it is exempt too. A MISSING
 * `type` defaults to `"text"` and is NOT exempt: a bare text input must be named.
 */
const NAME_EXEMPT_INPUT_TYPES: ReadonlySet<string> = new Set([
  "hidden",
  "submit",
  "button",
  "reset",
  "image",
  "checkbox",
  "radio",
]);

/**
 * Toggle controls — checkbox / switch / radio / toggle. These have a host of
 * `button` (Radix) or `input` (MUI/Chakra), so they'd otherwise be checked as a
 * button or a text input. But a toggle's accessible name almost always comes
 * from an EXTERNAL label the call site can't see: a sibling `<label>`, the text
 * of the row/cell it sits in, or a `<Text>` child rendered beside the box. We
 * cannot prove a toggle is nameless from its call site, so — per "uncertain →
 * skip" — the enforce check does NOT verify toggles at all. (The structural
 * jsx-a11y pass still checks the ones it can resolve.) Matched on the LEAF name.
 */
export const TOGGLE_NAMES: ReadonlySet<string> = new Set([
  "Checkbox",
  "Switch",
  "Radio",
  "Toggle",
  "RadioGroupItem",
  "RadioButton",
]);

/** The leaf of a JSX tag name (`NS.Member` -> `Member`, else the name). */
export function leafName(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? name : name.slice(dot + 1);
}

/**
 * Classify a name by the conservative heuristics. A name matches when it equals
 * the keyword or ends with it (suffix), so design-system aliases resolve. First
 * match in {@link NAME_HEURISTICS} wins (icon-button before button, etc.).
 */
export function typeFromName(name: string): ControlType | null {
  const leaf = leafName(name);
  for (const { type, keyword } of NAME_HEURISTICS) {
    if (leaf === keyword || leaf.endsWith(keyword)) {
      // `ButtonGroup`, `FieldArray`, `ImageList` etc. are CONTAINERS, not the
      // control — a keyword must be a SUFFIX (or the whole name), never a prefix.
      return type;
    }
  }
  return null;
}

/**
 * Classify a JSX element at the call site into a recognized control, or `null`
 * when it is not a recognized control (or recognition is uncertain). Three
 * sources, in confidence order — the first two yield `strength: "host"` (PROVEN
 * thin wrapper), the third `strength: "name"` (weaker, gated harder downstream):
 *
 *   1. resolved host  — the MODULE-SCOPED resolved-host map ({@link
 *      buildResolvedHosts}), keyed by `(name, import module)`. Authoritative: the
 *      tracer/registry/declaration proved a single forwarding host FOR THAT
 *      MODULE'S export. Scoping to the module is what stops a same-named export
 *      from another library (MUI `TextField` vs react-admin `TextField`) from
 *      lending its host across the collision.
 *   2. registry       — a known design-system export with one unambiguous host,
 *      even if it never landed in the map (e.g. the host is unmappable).
 *   3. name heuristic — a capitalized name that conventionally denotes a control
 *      (`Button`, `IconButton`, `ActionIcon`, `Link`, `Image`, `Dialog`,
 *      `Modal`). THIS is what reaches opaque/trusted components — but only those
 *      we can see the CHILDREN of (see {@link evaluate}); a self-closing
 *      name-only component is opaque and left alone.
 *
 * The name heuristic is GATED twice: (a) the element must be an IMPORTED
 * capitalized component — a bare lowercase intrinsic is jsx-a11y's job, and an
 * un-imported capitalized name is a local we don't recognize; and (b) its import
 * module must be a GUARANTEED design system (`lookupGuaranteed(module) !== null`).
 * Outside a known library a bare name is a guess, not evidence — react-admin's
 * `Button` is named by `label=` and renders no children, so a name-only match
 * would mass-false-positive. Icon-library imports are never controls (an icon is
 * content, not a control), so they short-circuit to `null`.
 */
function classify(
  tagName: string,
  resolvedHosts: ReadonlyMap<string, ResolvedHost>,
  imports: ReadonlyMap<string, ImportBinding>,
): Recognized | null {
  // Toggle controls (checkbox/switch/radio/toggle) are externally labelled by
  // convention — we can't verify their name at the call site, so skip them
  // outright before any host/name recognition claims them as button/input.
  if (TOGGLE_NAMES.has(leafName(tagName))) return null;

  // Native form-control intrinsics (`<input>`/`<select>`/`<textarea>`) are real
  // host controls jsx-a11y would own — but we don't run its
  // `control-has-associated-label`, so an unlabelled one slips through. Route
  // them through the SAME conservative input name-check `evaluate` runs for input
  // HOSTS. The exact-three set means no other intrinsic (`<td>`/`<div>`) is ever
  // claimed — the structural guard against the layout-cell false positives the
  // stock rule produces. (`tagName` is the bare lowercase tag; a capitalized
  // `Input` component is handled by resolution/registry below.)
  if (NATIVE_FORM_CONTROLS.has(tagName)) return { type: "input", strength: "host" };

  // The local binding (namespace local for `NS.Member`).
  const local = tagName.includes(".") ? tagName.slice(0, tagName.indexOf(".")) : tagName;
  const binding = imports.get(local);

  // 1. Resolved host wins — but ONLY when this call site's import module matches
  // the module the host was resolved from. The lookup key is `(name, module)`,
  // the same identity resolveComponents recorded, so a different module's
  // same-named export can never claim this host. (An un-imported local has no
  // binding and is never in the resolved-host map — it was never covered here.)
  if (binding !== undefined) {
    const resolved = resolvedHosts.get(`${tagName}@${binding.module}`);
    if (resolved !== undefined) {
      // A host carrying a TOGGLE role (`role="checkbox|switch|radio"`) is a
      // toggle reached via trace/host rather than by name — externally labelled,
      // so skip it exactly as TOGGLE_NAMES does. This is the role-aware
      // generalization: a Radix `Checkbox` traced to host `button` (role
      // `checkbox`) is no longer mistaken for a bare button.
      if (isToggleRole(resolved.role)) return null;
      // A wrapper that renders its host an internal STATIC name (an `sr-only`
      // span, a literal `aria-label`, or static text — the shadcn carousel
      // arrows) IS named even though the self-closing call site looks empty.
      // Skip it like a toggle: the name is real, it just lives inside the
      // wrapper. FN-safe — only ever suppresses, never adds a finding.
      if (resolved.rendersOwnName) return null;
      const fromHost = HOST_TO_TYPE[resolved.host];
      if (fromHost !== undefined) return { type: fromHost, strength: "host" };
    }
  }

  // An icon-library import is content, never a control — short-circuit.
  if (binding !== undefined && isIconLibrary(binding.module)) return null;

  // 1.5. Router link controls — react-router / Remix `Link` / `NavLink`. They
  // render `<a>` but carry the destination on `to`, not `href`, so they are kept
  // OUT of the structural jsx-a11y map (anchor-is-valid would false-positive on
  // the missing href — the 28-FP trap a hand-declared `"Link":"a"` produces).
  // Here in the CONTENT pass the check is name-based, so an icon-only / empty
  // router link with no accessible name is the genuine 2.4.4. host-strength: the
  // library contract guarantees a single `<a>`, so the call-site content IS the
  // link's name (a self-closing nameless one is really nameless).
  if (binding !== undefined && isRouterLinkControl(binding.module, binding.imported)) {
    return { type: "link", strength: "host" };
  }

  // 2. Registry: a known export with one unambiguous host.
  if (binding !== undefined) {
    const member = tagName.includes(".") ? leafName(tagName) : binding.imported;
    const reg = lookupRegistry(binding.module, member);
    if (reg !== null) {
      // Same role-aware toggle skip for a registry hit (antd `Switch` → button
      // with role `switch`) reached without a TOGGLE_NAMES match.
      if (isToggleRole(reg.role)) return null;
      const fromHost = HOST_TO_TYPE[reg.host];
      if (fromHost !== undefined) return { type: fromHost, strength: "host" };
    }
  }

  // 3. Name heuristic — only for IMPORTED capitalized components from a
  // GUARANTEED design system. This is the opaque/trusted reach; outside a known
  // library a bare name is a guess (the react-admin FP), so it never fires.
  if (binding === undefined) return null;
  if (!/^[A-Z]/.test(local)) return null;
  // GATE: a bare name is trusted ONLY inside a guaranteed design system. From an
  // unrecognized module (react-admin, a custom re-export) the name proves
  // nothing about the rendered control, so we refuse to guess.
  if (lookupGuaranteed(binding.module) === null) return null;
  const fromName = typeFromName(tagName);
  return fromName === null ? null : { type: fromName, strength: "name" };
}

/** ---- attribute / child inspection (all STATIC-only, by design) ---- */

/** Whether a JSX child is whitespace-only text or an empty expression (nothing). */
function isWhitespace(child: ts.JsxChild): boolean {
  if (ts.isJsxText(child)) return child.text.trim() === "";
  if (ts.isJsxExpression(child)) return child.expression === undefined;
  return false;
}

interface OpeningInfo {
  readonly opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement;
  readonly element: ts.JsxElement | ts.JsxSelfClosingElement;
}

function openingOf(node: ts.JsxElement | ts.JsxSelfClosingElement): OpeningInfo {
  return { opening: ts.isJsxElement(node) ? node.openingElement : node, element: node };
}

/** Whether the opening element spreads props (`{...props}`) — content unknowable. */
function spreadsProps(opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement): boolean {
  return opening.attributes.properties.some((p) => ts.isJsxSpreadAttribute(p));
}

/**
 * Whether `attr` is present AND carries a NON-EMPTY value we can read statically.
 * A dynamic expression (`aria-label={x}`) counts as present-and-unknowable, so
 * we treat it as "could be a name" — conservatism: never flag when uncertain.
 * Returns `"missing" | "present" | "dynamic"`.
 */
type AttrState = "missing" | "present" | "dynamic";

function attrState(
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  sf: ts.SourceFile,
  attrName: string,
): AttrState {
  for (const attr of opening.attributes.properties) {
    if (!ts.isJsxAttribute(attr)) continue;
    if (attr.name.getText(sf) !== attrName) continue;
    const init = attr.initializer;
    // Bare attribute (`hidden`) — present, treated as a (truthy) value.
    if (init === undefined) return "present";
    if (ts.isStringLiteral(init)) return init.text.trim() === "" ? "missing" : "present";
    if (ts.isJsxExpression(init)) {
      const expr = init.expression;
      if (expr === undefined) return "missing"; // `aria-label={}`
      if (ts.isStringLiteral(expr)) return expr.text.trim() === "" ? "missing" : "present";
      // Any other expression is dynamic/computed — unknowable, so "could name it".
      return "dynamic";
    }
    return "dynamic";
  }
  return "missing";
}

/** Whether ANY of the named attributes resolves a name (present or dynamic). */
function anyNameAttr(
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  sf: ts.SourceFile,
  names: readonly string[],
): boolean {
  return names.some((n) => attrState(opening, sf, n) !== "missing");
}

/**
 * Whether an input's `type` exempts it from the name check (see
 * {@link NAME_EXEMPT_INPUT_TYPES}). A static exempt value or a dynamic
 * `type={x}` (unknowable → skip) exempts; a missing or non-exempt static `type`
 * does not. Only meaningful for inputs — `<select>`/`<textarea>` carry no `type`,
 * so this is always `false` for them (they are always checked).
 */
function isNameExemptInputType(
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  sf: ts.SourceFile,
): boolean {
  for (const attr of opening.attributes.properties) {
    if (!ts.isJsxAttribute(attr) || attr.name.getText(sf) !== "type") continue;
    const init = attr.initializer;
    if (init === undefined) return false; // bare `type` — degenerate, treat as text
    if (ts.isStringLiteral(init)) return NAME_EXEMPT_INPUT_TYPES.has(init.text.trim().toLowerCase());
    if (ts.isJsxExpression(init)) {
      const expr = init.expression;
      if (expr !== undefined && ts.isStringLiteral(expr)) {
        return NAME_EXEMPT_INPUT_TYPES.has(expr.text.trim().toLowerCase());
      }
      return true; // `type={x}` — unknowable, exempt (uncertain → skip)
    }
    return true;
  }
  return false; // no `type` → defaults to "text" → checked
}

/**
 * Whether a control is statically HIDDEN or removed from the tab order, so an
 * absent label is not a real finding (uncertain → skip, FN-safe):
 *   - `tabIndex={-1}` / `tabIndex="-1"` — not keyboard-reachable in normal flow;
 *     in practice a hidden sentinel (react-select's required-field `<input>`) or
 *     a programmatically-focused target, externally driven, not a typed control;
 *   - the HTML `hidden` attribute (bare or `={true}`) — not rendered;
 *   - a `display:none` utility class (the standalone `hidden` token, Tailwind &
 *     co.) — removed from the accessibility tree, so it is never announced.
 * This mirrors the wide-sample false positives the native-control path would
 * otherwise produce (~7%): all six were one of these three shapes.
 */
function isHiddenOrUntabbable(
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  sf: ts.SourceFile,
): boolean {
  for (const attr of opening.attributes.properties) {
    if (!ts.isJsxAttribute(attr)) continue;
    const name = attr.name.getText(sf);
    const init = attr.initializer;
    if (name === "hidden") {
      if (init === undefined) return true; // bare `hidden`
      if (ts.isJsxExpression(init) && init.expression?.kind === ts.SyntaxKind.TrueKeyword) return true;
      continue;
    }
    if (name === "tabIndex" && init !== undefined) {
      if (init.getText(sf).replace(/[{}"'\s]/g, "") === "-1") return true;
      continue;
    }
    if (name === "className" || name === "class") {
      let str: string | null = null;
      if (init !== undefined && ts.isStringLiteral(init)) str = init.text;
      else if (init !== undefined && ts.isJsxExpression(init) && init.expression !== undefined && ts.isStringLiteral(init.expression)) {
        str = init.expression.text;
      }
      if (str !== null && /(^|\s)hidden(\s|$)/.test(str)) return true;
    }
  }
  return false;
}

/** The accessible-name attributes that, if present/dynamic, satisfy a control. */
const LABEL_ATTRS = ["aria-label", "aria-labelledby"] as const;
const NAME_ATTRS = [...LABEL_ATTRS, "title"] as const;
/**
 * Name attributes for an ACTIONABLE control (button / icon-button / link). Adds
 * `label` to {@link NAME_ATTRS}: several design systems name a button/link via a
 * `label=` prop instead of children — react-admin's `<Button label="Import"/>`,
 * Mantine, Blueprint. A `label=` present (or dynamic) means the control COULD be
 * named, so — per "uncertain → skip" — we don't flag. Harmless at worst (a false
 * negative if some library used `label` for something other than the name); it
 * protects against ANY known lib that names via `label=`, not just react-admin.
 *
 * NOT added for images (`alt` is the image name source, handled separately) or
 * inputs (which already honor `label` in their own branch).
 */
const CONTROL_NAME_ATTRS = [...NAME_ATTRS, "label"] as const;

/**
 * The static content verdict for an element's CHILDREN:
 *   - `text`    — has discernible static text (a real accessible name source).
 *   - `iconOnly`— children are exactly known icon component(s)/SVG, no text.
 *   - `empty`   — no children at all (self-closing or whitespace-only).
 *   - `dynamic` — children include a computed expression / non-icon component /
 *                 spread — content is unknowable, so we must NOT flag.
 *
 * `iconOnly` and `empty` are the only verdicts that, combined with no name attr,
 * justify a "no accessible name" finding. `dynamic` is the conservatism guard.
 */
type ChildVerdict = "text" | "iconOnly" | "empty" | "dynamic";

/**
 * Whether a JSX child element is a known icon — an icon-library import, or an
 * intrinsic `<svg>`. Icons carry no text, so icon-only children are "no name".
 * A capitalized child whose import is NOT an icon library is treated as possible
 * content (it could render text), so it makes the verdict `dynamic`, not iconOnly.
 */
function isIconChild(
  child: ts.JsxElement | ts.JsxSelfClosingElement,
  imports: ReadonlyMap<string, ImportBinding>,
): boolean {
  const opening = ts.isJsxElement(child) ? child.openingElement : child;
  const tag = opening.tagName;
  // Intrinsic <svg> is always an icon.
  if (ts.isIdentifier(tag)) {
    if (tag.text === "svg") return true;
    const binding = imports.get(tag.text);
    return binding !== undefined && isIconLibrary(binding.module);
  }
  if (ts.isPropertyAccessExpression(tag) && ts.isIdentifier(tag.expression)) {
    const binding = imports.get(tag.expression.text);
    return binding !== undefined && isIconLibrary(binding.module);
  }
  return false;
}

/**
 * Read the STATIC content verdict for an element's children. Conservative by
 * construction: any whiff of dynamic/computed/unknown content yields `dynamic`
 * (never flagged). Only literal text → `text`; only known icons → `iconOnly`;
 * nothing → `empty`.
 */
function childVerdict(
  node: ts.JsxElement | ts.JsxSelfClosingElement,
  imports: ReadonlyMap<string, ImportBinding>,
): ChildVerdict {
  if (!ts.isJsxElement(node)) return "empty"; // self-closing: no children
  let sawIcon = false;
  for (const child of node.children) {
    if (ts.isJsxText(child)) {
      if (child.text.trim() !== "") return "text";
      continue; // whitespace-only text is nothing
    }
    if (ts.isJsxExpression(child)) {
      // `{}` (empty/comment) is nothing; `{anything}` is computed -> dynamic.
      if (child.expression === undefined) continue;
      // A string literal child expression (`{"Save"}`) is real static text.
      if (ts.isStringLiteral(child.expression)) return "text";
      return "dynamic";
    }
    if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child)) {
      if (isIconChild(child, imports)) {
        sawIcon = true;
        continue;
      }
      // A non-icon child component could render text — unknowable. Don't flag.
      return "dynamic";
    }
    if (ts.isJsxFragment(child)) return "dynamic";
  }
  return sawIcon ? "iconOnly" : "empty";
}

/**
 * Whether an element has a recognizable label/title for a DIALOG. Dialogs are
 * the fuzziest control: a name can come from `aria-label`/`aria-labelledby`, a
 * `title=`/`label=` prop, OR a nested title subcomponent (`<Dialog.Title>`,
 * `<DialogTitle>`, `<ModalHeader>`). We flag ONLY when none of these is present
 * AND the dialog has NO dynamic children — i.e. clearly nameless. Anything
 * fuzzier is skipped (the corpus is least prescriptive here).
 */
function dialogHasName(info: OpeningInfo, sf: ts.SourceFile): boolean {
  if (anyNameAttr(info.opening, sf, NAME_ATTRS)) return true;
  if (attrState(info.opening, sf, "label") !== "missing") return true;
  if (attrState(info.opening, sf, "aria-describedby") !== "missing") {
    // describedby alone isn't a name, but its presence signals a wired dialog —
    // err toward NOT flagging (conservative for the fuzziest control).
    return true;
  }
  // A nested title subcomponent anywhere inside the dialog gives it a name.
  if (!ts.isJsxElement(info.element)) return false;
  let titled = false;
  const visit = (n: ts.Node): void => {
    if (titled) return;
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      const leaf = ts.isPropertyAccessExpression(n.tagName)
        ? n.tagName.name.text
        : ts.isIdentifier(n.tagName)
          ? n.tagName.text
          : "";
      if (/Title$|Header$|Heading$/.test(leaf)) titled = true;
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(info.element, visit);
  return titled;
}

/** Whether the element has any non-whitespace child (a visible body to inspect). */
function hasStaticBody(node: ts.JsxElement | ts.JsxSelfClosingElement): boolean {
  if (!ts.isJsxElement(node)) return false;
  return node.children.some((c) => !isWhitespace(c));
}

/**
 * Whether a dialog body has a COMPUTED child whose tag we can't classify — a
 * `{expr}` interpolation or a fragment that could render the title at runtime.
 * Static element children are fine: {@link dialogHasName} recursively searches
 * THEM for a title subcomponent, so a plain titled body is recognized. We skip
 * only when a title could be hiding inside an expression we can't read.
 */
function dialogHasDynamicBody(node: ts.JsxElement | ts.JsxSelfClosingElement): boolean {
  if (!ts.isJsxElement(node)) return false;
  return node.children.some(
    (c) => (ts.isJsxExpression(c) && c.expression !== undefined) || ts.isJsxFragment(c),
  );
}

/** ---- the rules ---- */

/** A rule's identity: a stable id + the WCAG SC it carries (mirrors the corpus). */
interface EnforceRule {
  readonly ruleId: string;
  readonly wcag: readonly string[];
  readonly message: string;
}

const RULES: Record<string, EnforceRule> = {
  buttonNoName: {
    ruleId: "enforce/button-no-name",
    wcag: ["4.1.2"],
    message:
      "Control resolves to a button but has no accessible name: children are empty or icon-only and there is no aria-label/aria-labelledby/title. Give it discernible text or an aria-label (corpus: 4.1.2-button-no-name).",
  },
  imageNoAlt: {
    ruleId: "enforce/image-no-alt",
    wcag: ["1.1.1"],
    message:
      'Control resolves to an image but has no alt and no aria-label/aria-labelledby. Add an alt that conveys the image\'s meaning, or alt="" if decorative (corpus: 1.1.1).',
  },
  linkNoName: {
    ruleId: "enforce/link-no-name",
    wcag: ["2.4.4"],
    message:
      "Control resolves to a link but has no discernible name: no text child and no aria-label/aria-labelledby/title. Give the link visible text or an aria-label that names its destination (corpus: 2.4.4-link-no-name).",
  },
  dialogNoName: {
    ruleId: "enforce/dialog-no-name",
    wcag: ["4.1.2", "1.3.1"],
    message:
      "Control resolves to a dialog/modal but has no accessible name: no aria-label/aria-labelledby, no title/label prop, and no nested title subcomponent. Name the dialog so assistive tech announces it (corpus: 4.1.2).",
  },
  inputNoName: {
    ruleId: "enforce/input-no-name",
    wcag: ["1.3.1", "3.3.2"],
    message:
      "Control resolves to a form input but has no associated label: no aria-label/aria-labelledby, no label/title prop, and no id to pair with a <label for>. Associate a real label (corpus: 1.3.1 / 3.3.2-form-control-no-name).",
  },
};

/**
 * Landmark / structural ARIA roles that ONE native HTML element provides
 * implicitly — the SAFE subset of `prefer-tag-over-role`. Deliberately excludes
 * widget roles (`combobox`, `img`, `status`, `presentation`, `menu`, `dialog`…):
 * those have no single clean native tag, or the role override IS the correct
 * pattern — an inline `<svg role="img" aria-label>` must NOT become `<img>`.
 * Running the stock jsx-a11y rule over every role is ~90% noise on real apps
 * (it fires on exactly those svg/status/combobox shapes); this is the landmark
 * slice that is unambiguous. `natives` are the tags already carrying the role.
 */
const SAFE_ROLE_TO_TAG: Readonly<
  Record<string, { readonly suggest: string; readonly natives: readonly string[] }>
> = {
  region: { suggest: "<section>", natives: ["section"] },
  navigation: { suggest: "<nav>", natives: ["nav"] },
  banner: { suggest: "<header>", natives: ["header"] },
  contentinfo: { suggest: "<footer>", natives: ["footer"] },
  main: { suggest: "<main>", natives: ["main"] },
  article: { suggest: "<article>", natives: ["article"] },
  list: { suggest: "<ul>/<ol>", natives: ["ul", "ol", "menu"] },
  listitem: { suggest: "<li>", natives: ["li"] },
  button: { suggest: "<button>", natives: ["button"] },
  heading: { suggest: "<h1>–<h6>", natives: ["h1", "h2", "h3", "h4", "h5", "h6"] },
};

const PREFER_TAG_RULE_ID = "enforce/prefer-tag-over-role";
const PREFER_TAG_WCAG: readonly string[] = ["1.3.1"];

/**
 * prefer-tag-over-role (scoped): a BARE intrinsic element (`<div>`/`<span>`/…)
 * carrying a static landmark/structural `role` a native tag provides implicitly
 * should use that tag. Fires ONLY on intrinsics (a resolved `<Button
 * role="combobox">` is a component — its semantics are the component's job, and
 * combobox is not a safe role anyway), ONLY for {@link SAFE_ROLE_TO_TAG}, and
 * never when the element ALREADY is a native equivalent (`<section
 * role="region">`). Returns the `role` attribute's line (the precise fix locus)
 * plus a per-role message, or null.
 */
function preferTagOverRole(
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  sf: ts.SourceFile,
): { readonly line: number; readonly message: string } | null {
  if (!ts.isIdentifier(opening.tagName)) return null; // intrinsic only (no NS.Member)
  const tag = opening.tagName.text;
  if (!/^[a-z]/.test(tag)) return null; // lowercase = intrinsic host element
  for (const attr of opening.attributes.properties) {
    if (!ts.isJsxAttribute(attr) || attr.name.getText(sf) !== "role") continue;
    const init = attr.initializer;
    let value: string | null = null;
    if (init !== undefined && ts.isStringLiteral(init)) value = init.text.trim().toLowerCase();
    else if (
      init !== undefined &&
      ts.isJsxExpression(init) &&
      init.expression !== undefined &&
      ts.isStringLiteral(init.expression)
    ) {
      value = init.expression.text.trim().toLowerCase();
    }
    if (value === null) return null; // dynamic / missing role value
    const native = SAFE_ROLE_TO_TAG[value];
    if (native === undefined) return null; // not a safe landmark role
    if (native.natives.includes(tag)) return null; // already the native element
    const line = sf.getLineAndCharacterOfPosition(attr.getStart(sf)).line + 1;
    return {
      line,
      message: `This <${tag}> sets role="${value}", which ${native.suggest} conveys natively. Use ${native.suggest} instead of the role so the semantics work without ARIA (corpus: 1.3.1-prefer-tag-over-role).`,
    };
  }
  return null;
}

/** What `evaluate` needs to know about the element's surroundings. */
interface EvalContext {
  /** How confidently the control was recognized (host = proven, name = weak). */
  readonly strength: Strength;
  /**
   * Whether a label-bearing component is an ANCESTOR of this element — `<label>`,
   * `Box as="label"`, `<FormLabel>`/`*Label`, or a form-field grouping
   * (`FormItem`/`FormControl`/`FormField`) that conventionally renders a label.
   * When true, an input's name likely comes from that label, so we don't flag.
   */
  readonly hasLabelAncestor: boolean;
  /**
   * Whether a NAME-INJECTING wrapper is an ANCESTOR of this element — a design
   * system `<Tooltip title="…">`. MUI/antd/Mantine Tooltips clone their single
   * child and inject the `title` as the child's `aria-label` by default (MUI:
   * `describeChild=false` ⇒ "the title acts as an accessible label for the
   * child"). So an icon-only `<IconButton>`/`<Button>`/`<Link>` directly inside a
   * titled Tooltip IS named at runtime — invisible at the call site, exactly like
   * an input under a `<label>`. This is the actionable-control counterpart to
   * {@link hasLabelAncestor}: when true, we cannot prove the control nameless, so
   * — per "uncertain → skip" — we don't flag button/icon-button/link.
   */
  readonly hasNameAncestor: boolean;
}

/**
 * Decide the enforce finding (if any) for one classified element. Returns the
 * rule that fired, or `null` when the content is present, dynamic, or otherwise
 * not clearly missing. EVERY branch defaults to "no finding" on uncertainty.
 *
 * The `strength` lever is the FP killer for the name heuristic: a `name`-strength
 * control (recognized only by suffix, never seen inside) is flagged ONLY when we
 * can see its CHILDREN are empty-or-icon — i.e. it's a visible container, not a
 * self-closing opaque component that may render its own label. A `host`-strength
 * control is a proven thin wrapper, so a self-closing nameless one IS nameless.
 */
function evaluate(
  type: ControlType,
  info: OpeningInfo,
  sf: ts.SourceFile,
  imports: ReadonlyMap<string, ImportBinding>,
  ctx: EvalContext,
): EnforceRule | null {
  const { opening, element } = info;

  // CONSERVATISM GUARD #1: a spread (`{...props}`) could carry ANY of the name
  // attributes (aria-label, alt, id, label). Content is unknowable -> never flag.
  if (spreadsProps(opening)) return null;

  switch (type) {
    case "button":
    case "icon-button": {
      // A titled design-system Tooltip ancestor injects the child's name at
      // runtime (see EvalContext.hasNameAncestor) — can't prove it nameless.
      if (ctx.hasNameAncestor) return null;
      if (anyNameAttr(opening, sf, CONTROL_NAME_ATTRS)) return null;
      const v = childVerdict(element, imports);
      // CONSERVATISM GUARD #2: a `name`-strength control that is SELF-CLOSING /
      // empty is opaque — it likely renders its own label internally (a custom
      // `<QuickCreateButton/>`). Only flag a name-only control when we can SEE
      // an icon-only child (a visible container). A `host`-strength control is a
      // proven thin wrapper, so empty-or-icon both flag.
      if (ctx.strength === "name" && v === "empty") return null;
      return v === "empty" || v === "iconOnly" ? RULES.buttonNoName : null;
    }
    case "image": {
      // CONSERVATISM GUARD: only a HOST-strength image (resolved/registry `img`,
      // a proven thin wrapper) is checked. A name-only `*Image`/`AvatarImage`
      // wrapper is opaque — it commonly derives its own alt from a `name`/`title`
      // prop internally (avatar components), so we can't prove it nameless. Skip.
      if (ctx.strength !== "host") return null;
      // alt present (even empty alt="" = decorative) OR a label attr => named.
      // alt="" is intentional decorative marking, NOT a violation -> not flagged
      // (attrState treats empty alt as "missing", so check alt presence directly).
      if (hasAltAttr(opening, sf)) return null;
      if (anyNameAttr(opening, sf, LABEL_ATTRS)) return null;
      return RULES.imageNoAlt;
    }
    case "link": {
      if (ctx.hasNameAncestor) return null; // titled Tooltip ancestor names it
      if (anyNameAttr(opening, sf, CONTROL_NAME_ATTRS)) return null;
      const v = childVerdict(element, imports);
      if (ctx.strength === "name" && v === "empty") return null; // same guard #2
      // A link with only an icon child and no name is the 2.4.4-link-no-name
      // shape; empty likewise (host-strength). text/dynamic => skip.
      return v === "empty" || v === "iconOnly" ? RULES.linkNoName : null;
    }
    case "dialog": {
      // Fuzziest control: flag only when CLEARLY nameless. A name-strength dialog
      // is recognized only by a `*Dialog`/`*Modal` suffix — if it's self-closing
      // / bodyless at the call site it's an OPAQUE wrapper that renders its own
      // <DialogTitle> internally (the dominant case), so we can't prove it
      // nameless. Only inspect a dialog whose BODY we can see (a host-strength
      // primitive, or a name-strength container with static children).
      if (ctx.strength === "name" && !hasStaticBody(element)) return null;
      if (dialogHasName(info, sf)) return null;
      if (dialogHasDynamicBody(element)) return null;
      return RULES.dialogNoName;
    }
    case "input": {
      // Inputs reach here via a real input HOST — a resolved wrapper, or a native
      // `<input>`/`<select>`/`<textarea>` intrinsic (never the name heuristic).
      // A submit/button/reset is named by its `value`, hidden/image/checkbox/radio
      // are not text-name-bearing or are externally-labelled toggles — exempt by
      // `type` before any name check (a `<input type="submit"/>` is not nameless).
      if (isNameExemptInputType(opening, sf)) return null;
      // Hidden / untabbable controls (display:none, `hidden`, `tabIndex={-1}`
      // sentinels) aren't operable/announced controls — an absent label is moot.
      if (isHiddenOrUntabbable(opening, sf)) return null;
      // A name can come from aria-label/labelledby, a label/title prop, an id
      // paired with a <label for>, OR a label ANCESTOR (FormLabel/Box as="label").
      // Any of those = "could be labelled" -> conservative skip; placeholder is
      // NOT a label, so its presence does NOT clear the finding.
      if (ctx.hasLabelAncestor) return null;
      if (anyNameAttr(opening, sf, NAME_ATTRS)) return null;
      if (attrState(opening, sf, "label") !== "missing") return null;
      if (attrState(opening, sf, "id") !== "missing") return null;
      // CHILDREN on a WRAPPER input host mean a composite that labels itself with
      // its content — skip (conservative; a real text input is self-closing). But
      // a NATIVE `<select>`/`<textarea>` ALWAYS has children — its `<option>`s or
      // default value — which are NOT a label, so the guard must not reach them,
      // or every native select/textarea would go unchecked.
      const isNativeFormControl =
        ts.isIdentifier(opening.tagName) && NATIVE_FORM_CONTROLS.has(opening.tagName.text);
      if (
        !isNativeFormControl &&
        ts.isJsxElement(element) &&
        element.children.some((c) => !isWhitespace(c))
      ) {
        return null;
      }
      return RULES.inputNoName;
    }
  }
}

/**
 * Whether the element carries an `alt` attribute at all (present, empty, or
 * dynamic). For images, an explicit `alt=""` is a deliberate decorative marking
 * and must NOT be flagged — so we check PRESENCE, not non-emptiness.
 */
function hasAltAttr(
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  sf: ts.SourceFile,
): boolean {
  return opening.attributes.properties.some(
    (p) => ts.isJsxAttribute(p) && p.name.getText(sf) === "alt",
  );
}

/**
 * Whether a JSX element is (or renders) a LABEL container — so an input nested
 * under it likely gets its name from that label and must NOT be flagged:
 *
 *   - intrinsic `<label>`;
 *   - `<X as="label">` / `<X component="label">` (Saleor `Box as="label"`, MUI);
 *   - a component whose leaf name ends with `Label` (`FormLabel`, `InputLabel`);
 *   - a form-field grouping (`FormItem`/`FormControl`/`FormField`/`FormGroup`)
 *     — the react-hook-form / shadcn / MUI convention that pairs a label with
 *     the control it wraps. Recognizing the GROUP is conservative: it suppresses
 *     even when the label sibling is rendered conditionally or further out.
 */
function isLabelContainer(
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  sf: ts.SourceFile,
): boolean {
  const tag = opening.tagName;
  if (ts.isIdentifier(tag) && tag.text === "label") return true;
  // `as`/`component` polymorphic prop set to the string "label".
  for (const attr of opening.attributes.properties) {
    if (!ts.isJsxAttribute(attr)) continue;
    const n = attr.name.getText(sf);
    if (n !== "as" && n !== "component") continue;
    const init = attr.initializer;
    if (init !== undefined && ts.isStringLiteral(init) && init.text === "label") return true;
    if (
      init !== undefined &&
      ts.isJsxExpression(init) &&
      init.expression !== undefined &&
      ts.isStringLiteral(init.expression) &&
      init.expression.text === "label"
    ) {
      return true;
    }
  }
  const leaf = ts.isPropertyAccessExpression(tag)
    ? tag.name.text
    : ts.isIdentifier(tag)
      ? tag.text
      : "";
  if (leaf.endsWith("Label")) return true;
  return /^(Form(Item|Control|Field|Group)|Field)$/.test(leaf);
}

/**
 * Whether an element is a NAME-INJECTING wrapper for its single child control: a
 * design-system `<Tooltip>` carrying a `title` (or `aria-label`). MUI / antd /
 * Mantine Tooltips clone their child and set the `title` as the child's
 * `aria-label` by default (MUI: `describeChild=false` ⇒ "the title acts as an
 * accessible label for the child"). So a nested icon-only `<IconButton>` /
 * `<Button>` / `<Link>` is NAMED at runtime even though the call site shows no
 * `aria-label` — the actionable-control analogue of an input under a `<label>`.
 *
 * Matched on the LEAF name `Tooltip` (so `Tooltip`, `MyTooltip`, `Tooltip.Root`
 * all qualify) AND only when a `title`/`aria-label` is actually present — a
 * Tooltip with no title injects no name, so it must not suppress. A bare
 * `describeChild` Tooltip (title → description, not name) is the rare opposite;
 * we accept the small false-negative risk there in exchange for killing the
 * dominant, idiomatic titled-Tooltip false positive.
 */
function isNameInjectingWrapper(
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  sf: ts.SourceFile,
): boolean {
  const tag = opening.tagName;
  const leaf = ts.isPropertyAccessExpression(tag)
    ? tag.name.text
    : ts.isIdentifier(tag)
      ? tag.text
      : "";
  if (!leaf.endsWith("Tooltip")) return false;
  // The title must actually be there to inject a name (present or dynamic).
  return attrState(opening, sf, "title") !== "missing" || anyNameAttr(opening, sf, LABEL_ATTRS);
}

/**
 * Run the enforce content check across the given `.tsx` files. Produces a
 * `Finding` per clear, static, app-owned content gap on a recognized control —
 * INCLUDING opaque/trusted components. Findings are tagged `provenance:
 * "enforce"`; the caller dedupes them against the jsx-a11y findings.
 *
 * Suppression mirrors the structural pass: a control on a line covered by a
 * Trans/render injection or `aria-hidden` is contentful/out-of-tree at runtime,
 * so the "no content" premise doesn't hold — those are skipped too. The walk
 * carries a `labelDepth` so an input under a label/form-field grouping isn't
 * flagged (its name comes from that label).
 */
export function enforceContent(filePaths: readonly string[], ctx: EnforceContext): Finding[] {
  const injectsChildren = ctx.declarations?.injectsChildren ?? [];
  // Module-scoped resolved-host lookup — the FP-safe replacement for jsx-a11y's
  // leaf-keyed flat map (see {@link EnforceContext.resolutions}).
  const resolvedHosts = buildResolvedHosts(ctx.resolutions);
  const out: Finding[] = [];

  for (const filePath of filePaths) {
    const text = ts.sys.readFile(filePath);
    if (text === undefined) continue;
    const sf = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const imports = collectLocalImports(sf);
    // Same runtime-injection / aria-hidden ranges the structural pass uses, so a
    // control made contentful at runtime isn't flagged here either.
    const suppressed = [
      ...transInjectedLineRanges(sf, injectsChildren),
      ...ariaHiddenLineRanges(sf),
    ];
    const lineOf = (pos: number): number => sf.getLineAndCharacterOfPosition(pos).line + 1;
    const isSuppressed = (line: number): boolean =>
      suppressed.some((r) => line >= r.start && line <= r.end);

    // Depth of enclosing label/form-field containers — when > 0, an input here
    // is conventionally labelled by an ancestor and must not be flagged.
    let labelDepth = 0;
    // Depth of enclosing name-injecting wrappers (titled `<Tooltip>`) — when > 0,
    // an actionable control here is named by that ancestor at runtime.
    let nameAncestorDepth = 0;

    const visit = (node: ts.Node): void => {
      let enteredLabel = false;
      let enteredNameAncestor = false;
      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
        const info = openingOf(node);
        const tagNode = info.opening.tagName;
        if (isLabelContainer(info.opening, sf)) {
          labelDepth++;
          enteredLabel = true;
        }
        if (isNameInjectingWrapper(info.opening, sf)) {
          nameAncestorDepth++;
          enteredNameAncestor = true;
        }
        const tag = ts.isIdentifier(tagNode)
          ? tagNode.text
          : ts.isPropertyAccessExpression(tagNode) && ts.isIdentifier(tagNode.expression)
            ? `${tagNode.expression.text}.${tagNode.name.text}`
            : null;
        if (tag !== null) {
          const recognized = classify(tag, resolvedHosts, imports);
          if (recognized !== null) {
            const rule = evaluate(recognized.type, info, sf, imports, {
              strength: recognized.strength,
              hasLabelAncestor: labelDepth > 0,
              hasNameAncestor: nameAncestorDepth > 0,
            });
            const line = lineOf(info.opening.getStart(sf));
            if (rule !== null && !isSuppressed(line)) {
              out.push({
                file: filePath,
                line,
                ruleId: rule.ruleId,
                message: rule.message,
                wcag: rule.wcag,
                enforcement: enforcementFor(rule.wcag, ctx.contract),
                provenance: "enforce",
              });
            }
          }

          // prefer-tag-over-role is independent of control classification: any
          // bare intrinsic with a landmark/structural role a native tag conveys.
          const ptr = preferTagOverRole(info.opening, sf);
          if (ptr !== null && !isSuppressed(ptr.line)) {
            out.push({
              file: filePath,
              line: ptr.line,
              ruleId: PREFER_TAG_RULE_ID,
              message: ptr.message,
              wcag: PREFER_TAG_WCAG,
              enforcement: enforcementFor(PREFER_TAG_WCAG, ctx.contract),
              provenance: "enforce",
            });
          }
        }
      }
      ts.forEachChild(node, visit);
      if (enteredLabel) labelDepth--;
      if (enteredNameAncestor) nameAncestorDepth--;
    };
    visit(sf);
  }

  return out;
}
