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
import {
  anyNameAttr,
  attrState,
  isHiddenOrUntabbable,
  isLabelContainer,
  isNameExemptInputType,
  isNameInjectingWrapper,
  LABEL_ATTRS,
} from "./suppressors";

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
 * The WCAG SC family each control type carries when enforce CONSIDERS it. Used
 * to label a G4 abstention (see {@link EvalOutcome}) with the SC the floor
 * deliberately stayed silent on — the recall layer needs the SC, not the
 * rule-id, since an abstention is "I looked at this SC here and declined".
 */
const TYPE_TO_WCAG: Readonly<Record<ControlType, readonly string[]>> = {
  button: RULES.buttonNoName.wcag,
  "icon-button": RULES.buttonNoName.wcag,
  link: RULES.linkNoName.wcag,
  image: RULES.imageNoAlt.wcag,
  dialog: RULES.dialogNoName.wcag,
  input: RULES.inputNoName.wcag,
};

/**
 * The verdict `evaluate` reaches for one classified element — a three-way split
 * that distinguishes the floor's two kinds of "no finding":
 *
 *   - `finding` — the control is CLEARLY nameless; emit the rule (floor finding).
 *   - `abstain` — enforce CONSIDERED this SC here and DELIBERATELY declined
 *     because the content is unknowable (a `{...props}` spread, a computed/
 *     dynamic child, an opaque name-strength wrapper). This is the G4 abstention
 *     signal: "the floor looked and stayed silent — not because it's named, but
 *     because it can't tell." A grounded recall finding on such a line is vetoed.
 *   - `clean` — the control IS named (a real name attr, static text, an alt, an
 *     ancestor label/Tooltip). The floor is silent because there's nothing to
 *     find; NOT an abstention (the recall layer may still flag elsewhere, but
 *     this line is genuinely fine).
 *
 * Only the `finding` arm produces a floor finding, so the emitted findings are
 * byte-identical to the prior `EnforceRule | null` contract — `abstain` and
 * `clean` both map to "no finding" exactly as `null` did.
 */
type EvalOutcome =
  | { readonly kind: "finding"; readonly rule: EnforceRule }
  | { readonly kind: "abstain"; readonly wcag: readonly string[] }
  | { readonly kind: "clean" };

/**
 * Decide the enforce outcome for one classified element. Returns `finding` when
 * the control is clearly nameless, `abstain` when the content is unknowable
 * (spread / dynamic child / opaque wrapper — the G4 signal), or `clean` when the
 * control is named. EVERY uncertain branch resolves to `abstain` or `clean`,
 * never `finding`.
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
): EvalOutcome {
  const { opening, element } = info;
  const abstain: EvalOutcome = { kind: "abstain", wcag: TYPE_TO_WCAG[type] };
  const clean: EvalOutcome = { kind: "clean" };

  // CONSERVATISM GUARD #1: a spread (`{...props}`) could carry ANY of the name
  // attributes (aria-label, alt, id, label). Content is unknowable -> abstain.
  if (spreadsProps(opening)) return abstain;

  switch (type) {
    case "button":
    case "icon-button": {
      // A titled design-system Tooltip ancestor injects the child's name at
      // runtime (see EvalContext.hasNameAncestor) — named, not nameless.
      if (ctx.hasNameAncestor) return clean;
      if (anyNameAttr(opening, sf, CONTROL_NAME_ATTRS)) return clean;
      const v = childVerdict(element, imports);
      // A computed/non-icon child could render the name — content unknowable.
      if (v === "dynamic") return abstain;
      if (v === "text") return clean;
      // CONSERVATISM GUARD #2: a `name`-strength control that is SELF-CLOSING /
      // empty is opaque — it likely renders its own label internally (a custom
      // `<QuickCreateButton/>`). Only flag a name-only control when we can SEE
      // an icon-only child (a visible container). A `host`-strength control is a
      // proven thin wrapper, so empty-or-icon both flag.
      if (ctx.strength === "name" && v === "empty") return abstain;
      return { kind: "finding", rule: RULES.buttonNoName };
    }
    case "image": {
      // CONSERVATISM GUARD: only a HOST-strength image (resolved/registry `img`,
      // a proven thin wrapper) is checked. A name-only `*Image`/`AvatarImage`
      // wrapper is opaque — it commonly derives its own alt from a `name`/`title`
      // prop internally (avatar components), so we can't prove it nameless.
      if (ctx.strength !== "host") return abstain;
      // alt present (even empty alt="" = decorative) OR a label attr => named.
      // alt="" is intentional decorative marking, NOT a violation -> not flagged
      // (attrState treats empty alt as "missing", so check alt presence directly).
      if (hasAltAttr(opening, sf)) return clean;
      if (anyNameAttr(opening, sf, LABEL_ATTRS)) return clean;
      return { kind: "finding", rule: RULES.imageNoAlt };
    }
    case "link": {
      if (ctx.hasNameAncestor) return clean; // titled Tooltip ancestor names it
      if (anyNameAttr(opening, sf, CONTROL_NAME_ATTRS)) return clean;
      const v = childVerdict(element, imports);
      if (v === "dynamic") return abstain;
      if (v === "text") return clean;
      if (ctx.strength === "name" && v === "empty") return abstain; // same guard #2
      // A link with only an icon child and no name is the 2.4.4-link-no-name
      // shape; empty likewise (host-strength).
      return { kind: "finding", rule: RULES.linkNoName };
    }
    case "dialog": {
      // Fuzziest control: flag only when CLEARLY nameless. A name-strength dialog
      // is recognized only by a `*Dialog`/`*Modal` suffix — if it's self-closing
      // / bodyless at the call site it's an OPAQUE wrapper that renders its own
      // <DialogTitle> internally (the dominant case), so we can't prove it
      // nameless. Only inspect a dialog whose BODY we can see (a host-strength
      // primitive, or a name-strength container with static children).
      if (ctx.strength === "name" && !hasStaticBody(element)) return abstain;
      if (dialogHasName(info, sf)) return clean;
      if (dialogHasDynamicBody(element)) return abstain;
      return { kind: "finding", rule: RULES.dialogNoName };
    }
    case "input": {
      // Inputs reach here via a real input HOST — a resolved wrapper, or a native
      // `<input>`/`<select>`/`<textarea>` intrinsic (never the name heuristic).
      // A submit/button/reset is named by its `value`, hidden/image/checkbox/radio
      // are not text-name-bearing or are externally-labelled toggles — exempt by
      // `type` before any name check (a `<input type="submit"/>` is not nameless).
      if (isNameExemptInputType(opening, sf)) return clean;
      // Hidden / untabbable controls (display:none, `hidden`, `tabIndex={-1}`
      // sentinels) aren't operable/announced controls — an absent label is moot.
      if (isHiddenOrUntabbable(opening, sf)) return clean;
      // A name can come from aria-label/labelledby, a label/title prop, an id
      // paired with a <label for>, OR a label ANCESTOR (FormLabel/Box as="label").
      // Any of those = "could be labelled" -> conservative skip; placeholder is
      // NOT a label, so its presence does NOT clear the finding.
      if (ctx.hasLabelAncestor) return clean;
      if (anyNameAttr(opening, sf, NAME_ATTRS)) return clean;
      if (attrState(opening, sf, "label") !== "missing") return clean;
      if (attrState(opening, sf, "id") !== "missing") return clean;
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
        // A composite wrapper that labels itself with its own content — not a
        // bare nameless input, but not provably named either: abstain.
        return abstain;
      }
      return { kind: "finding", rule: RULES.inputNoName };
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

/** A located enforce finding before it is decorated with file/enforcement/provenance. */
interface EnforceFinding {
  readonly line: number;
  readonly ruleId: string;
  readonly message: string;
  readonly wcag: readonly string[];
}

/**
 * A G4 abstention marker: the floor CONSIDERED a control at this `line` for this
 * WCAG `sc` and DELIBERATELY emitted no finding because the content is unknowable
 * (spread / dynamic child / opaque wrapper). Carries no message — it is not a
 * finding, it is the record that the floor looked and declined, which vetoes a
 * grounded recall finding on the same `line` + `sc` (RFC Phase 1, G4).
 */
export interface AbstentionMarker {
  readonly line: number;
  readonly sc: string;
}

/** An {@link AbstentionMarker} anchored to its file — the exposed G4 record. */
export interface LocatedAbstention extends AbstentionMarker {
  readonly file: string;
}

/** Everything an element check needs about one JSX element and its surroundings. */
interface ElementCheckArgs {
  readonly info: OpeningInfo;
  /** The JSX tag (`div`, `Button`, `NS.Member`), already flattened. */
  readonly tag: string;
  readonly sf: ts.SourceFile;
  readonly imports: ReadonlyMap<string, ImportBinding>;
  readonly resolvedHosts: ReadonlyMap<string, ResolvedHost>;
  /** Enclosing `<label>`/form-field depth; > 0 ⇒ an input here is labelled by an ancestor. */
  readonly labelDepth: number;
  /** Enclosing titled-`<Tooltip>` depth; > 0 ⇒ a control here is named at runtime. */
  readonly nameAncestorDepth: number;
  /**
   * Sink for G4 abstentions — a check that CONSIDERED a control here and declined
   * (unknowable content) pushes a {@link AbstentionMarker}. Side-channel only:
   * it never affects the returned finding, so floor findings stay byte-identical.
   */
  readonly abstentions: AbstentionMarker[];
}

/**
 * One enforce rule, as a pure `(element) -> finding | null`. This is the seam
 * that keeps the visitor open/closed: a new rule is a new check appended to
 * {@link ELEMENT_CHECKS}, never a new branch threaded through the walk. Each
 * check owns its own rule id, WCAG, message, AND reported line (control-name
 * reports the element opening; prefer-tag the role attribute).
 */
type ElementCheck = (args: ElementCheckArgs) => EnforceFinding | null;

/**
 * Control-name family: `classify` the tag to a control type, then `evaluate`
 * whether that control lacks an accessible name. The original enforce rule set
 * (button/input/link/image/dialog), sourcing its metadata from {@link RULES}.
 */
const controlNameCheck: ElementCheck = (a) => {
  const recognized = classify(a.tag, a.resolvedHosts, a.imports);
  if (recognized === null) return null;
  const outcome = evaluate(recognized.type, a.info, a.sf, a.imports, {
    strength: recognized.strength,
    hasLabelAncestor: a.labelDepth > 0,
    hasNameAncestor: a.nameAncestorDepth > 0,
  });
  const line = a.sf.getLineAndCharacterOfPosition(a.info.opening.getStart(a.sf)).line + 1;
  if (outcome.kind === "abstain") {
    // G4 side-channel: the floor looked at this SC here and declined. Record the
    // abstention WITHOUT emitting a finding — floor output is unchanged.
    for (const sc of outcome.wcag) a.abstentions.push({ line, sc });
    return null;
  }
  if (outcome.kind === "clean") return null;
  const rule = outcome.rule;
  return { line, ruleId: rule.ruleId, message: rule.message, wcag: rule.wcag };
};

/** prefer-tag-over-role family: a bare intrinsic with a landmark role + native tag. */
const preferTagCheck: ElementCheck = (a) => {
  const ptr = preferTagOverRole(a.info.opening, a.sf);
  if (ptr === null) return null;
  return { line: ptr.line, ruleId: PREFER_TAG_RULE_ID, message: ptr.message, wcag: PREFER_TAG_WCAG };
};

/**
 * Every enforce element check, run against EVERY JSX element in source order.
 * To add a rule, append a check here — the visitor neither knows nor cares what
 * each one does. Order is finding order, so keep the original families first.
 */
const ELEMENT_CHECKS: readonly ElementCheck[] = [controlNameCheck, preferTagCheck];

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
  return enforceContentWithAbstentions(filePaths, ctx).findings;
}

/**
 * The enforce pass plus its G4 abstention markers (RFC Phase 1, §1b). Identical
 * to {@link enforceContent} for `findings` — same walk, byte-identical floor
 * output — but additionally returns every {@link AbstentionMarker}: a line+SC the
 * floor CONSIDERED a control at and deliberately declined (spread / dynamic child
 * / opaque wrapper). `enforceContent` is this with the abstentions dropped, so no
 * existing caller (scan, the CLI) sees any change.
 */
export function enforceContentWithAbstentions(
  filePaths: readonly string[],
  ctx: EnforceContext,
): { readonly findings: Finding[]; readonly abstentions: readonly LocatedAbstention[] } {
  const injectsChildren = ctx.declarations?.injectsChildren ?? [];
  // Module-scoped resolved-host lookup — the FP-safe replacement for jsx-a11y's
  // leaf-keyed flat map (see {@link EnforceContext.resolutions}).
  const resolvedHosts = buildResolvedHosts(ctx.resolutions);
  const out: Finding[] = [];
  const abstentions: LocatedAbstention[] = [];

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
          // Per-element abstention buffer: collected by the checks, then kept
          // only if the element's line is not range-suppressed (same gate as a
          // finding) — so an abstention never appears where a finding couldn't.
          const elemAbstentions: AbstentionMarker[] = [];
          const args: ElementCheckArgs = {
            info,
            tag,
            sf,
            imports,
            resolvedHosts,
            labelDepth,
            nameAncestorDepth,
            abstentions: elemAbstentions,
          };
          for (const check of ELEMENT_CHECKS) {
            const finding = check(args);
            if (finding !== null && !isSuppressed(finding.line)) {
              out.push({
                file: filePath,
                line: finding.line,
                ruleId: finding.ruleId,
                message: finding.message,
                wcag: finding.wcag,
                enforcement: enforcementFor(finding.wcag, ctx.contract),
                provenance: "enforce",
              });
            }
          }
          // Flush the element's abstentions, same suppression gate as a finding.
          for (const a of elemAbstentions) {
            if (!isSuppressed(a.line)) abstentions.push({ file: filePath, ...a });
          }
        }
      }
      ts.forEachChild(node, visit);
      if (enteredLabel) labelDepth--;
      if (enteredNameAncestor) nameAncestorDepth--;
    };
    visit(sf);
  }

  return { findings: out, abstentions };
}
