/**
 * `init --suggest`: scaffold the `binclusive.json` `components` map by GUESSING,
 * from each unresolved wrapper's NAME, the HTML host it most likely renders.
 *
 * This removes the one manual step in adoption. Today a team with a custom
 * design system hand-writes `{ "Button": "button", "TextField": "input", … }`;
 * this pre-fills that map with best-guess hosts for the design-system's leaf
 * primitives, for the team to REVIEW before committing.
 *
 * CONSERVATISM IS THE WHOLE DISCIPLINE (same as `enforce.ts`). A name guess is
 * weaker evidence than a registry hit or a source trace — auto-applying one
 * silently is exactly how you'd manufacture false positives. So this module:
 *
 *   - SUGGESTS, never decides: every guess is printed for review, and the
 *     uncertain ones carry a ⚠ `verify` flag so the user looks twice.
 *   - is OPT-IN behind `--suggest`: plain `init` writes no guessed map. The
 *     suggestions only land in `binclusive.json` when the user asked for them.
 *   - SKIPS composites: a name that names a multi-element widget (`Modal`,
 *     `Dropdown`, `Tabs`, a `*Provider`, …) has NO single host, so it stays in
 *     the declare bucket rather than being mis-mapped to one element.
 *   - SKIPS toggles: `Checkbox`/`Switch`/`Radio`/`Toggle` are externally
 *     labelled — enforce skips them, and so does the suggestion (mapping one to
 *     `input`/`button` would invite the same false positives enforce avoids).
 *
 * The guess vocabulary REUSES `enforce.ts` (`NAME_HEURISTICS` / `typeFromName`)
 * for the control types those heuristics already know (button / icon-button /
 * link / image), and extends it with the input-family leaf names enforce
 * deliberately omits. Enforce omits inputs because their accessible name comes
 * from an external label it can't see at the call site — a FALSE-POSITIVE risk
 * for an enforcing check. A SUGGESTION carries no such risk: it only proposes a
 * host for the user to confirm, never fires a finding, so suggesting `input`
 * for `*TextField` / `*Input` / `*Field` is safe and is the whole point.
 */

import type { ControlType } from "./enforce";
import { leafName, TOGGLE_NAMES, typeFromName } from "./enforce";
import { familyLabel, isFrameworkPrimitive, isOwnModule, packageNameOf } from "./module-scope";
import type { ComponentResolution } from "./resolve-components";

/**
 * How confident the host guess is — the lever that keeps a name guess from
 * being mistaken for a proven host:
 *
 *   - `confident` — the leaf name maps UNAMBIGUOUSLY to one host (`*Button` →
 *     `button`, `*TextField` → `input`, `*Link` → `a`, `*Avatar` → `img`).
 *     Printed with a ✓; still review-only, but a safe default.
 *   - `verify`    — the name maps to a host that is OFTEN a custom widget rather
 *     than the native element (`Select` → could be a combobox, not a native
 *     `<select>`), or only loosely matches. Printed with a ⚠ and a reason, so
 *     the user looks twice before trusting it.
 */
export type SuggestConfidence = "confident" | "verify";

/** One suggested wrapper → host mapping, with its confidence and source. */
export interface ComponentSuggestion {
  /**
   * The `components`-map KEY: the wrapper's LEAF name (`CommandPrimitive.Input`
   * → `Input`), the same key the declared-host lookup matches on, so the
   * scaffolded entry actually takes effect. Usually identical to the JSX name.
   */
  readonly name: string;
  /** The module it is imported from, e.g. `"@acme/ui"`. */
  readonly module: string;
  /** The guessed HTML host primitive, e.g. `"button"` / `"input"` / `"a"`. */
  readonly host: string;
  readonly confidence: SuggestConfidence;
  /** A short reason, present ONLY for a `verify` guess; `null` for `confident`. */
  readonly reason: string | null;
}

/** The full outcome of a suggestion pass, for the CLI to print + persist. */
export interface SuggestResult {
  /** The suggested wrapper → host mappings, sorted for a deterministic report. */
  readonly suggestions: readonly ComponentSuggestion[];
  /**
   * Declare-bucket components left UNMAPPED because they are composites (no
   * single host) or toggles — kept so the CLI can print "left in declare".
   * Names only, deduped, sorted.
   */
  readonly skipped: readonly string[];
}

/** Inputs for {@link suggestComponentMap}, parallel to `detect-stack`'s scoping. */
export interface SuggestOptions {
  /**
   * Predicate identifying a module specifier that resolves to the repo's OWN
   * code (relative imports, `@/`, `~`, `#`, and tsconfig path aliases that map
   * into own source). Own components are one-offs, not a design system — they
   * are never suggested. Mirror `ownAliasMatcherFor(dir).isOwnAlias`.
   */
  readonly isOwnAlias: (specifier: string) => boolean;
  /**
   * The detected design-system LABEL (e.g. `"@acme/ui"`, or a collapsed family
   * name like `"Radix"`), or `null`/`"custom"` when none was detected.
   * Suggestions from this design system sort FIRST so the most relevant guesses
   * lead the printed list; it does not gate inclusion. The rank comparison
   * collapses each suggestion's package through {@link familyLabel} so a family
   * label still matches its per-component sub-packages.
   */
  readonly designSystem: string | null;
}

/**
 * Composite leaf names — multi-element widgets with NO single host element, so
 * they CANNOT be mapped to one primitive and stay in the declare bucket. Each is
 * a whole-name or suffix match (so `ConfirmDialog`, `UserMenu`, `SidePanel`
 * resolve), never a prefix (a `CardGrid` is its own thing). This is the
 * conservative inverse of the leaf-control vocabulary: when a name is a
 * composite, we REFUSE to guess a host rather than mis-map it.
 *
 * Kept SEPARATE from enforce's `dialog` heuristic on purpose: enforce treats
 * `Dialog`/`Modal` as a recognizable control TYPE (for its dialog rule), but for
 * HOST mapping a dialog has no single element — so here it is a composite to
 * skip, not a host to suggest.
 */
const COMPOSITE_KEYWORDS: readonly string[] = [
  "Modal",
  "Dialog",
  "Drawer",
  "Sheet",
  "Popover",
  "Tooltip",
  "Dropdown",
  "Menu",
  "Tabs",
  "Tab",
  "Accordion",
  "Collapse",
  "Carousel",
  "Card",
  "Panel",
  "Layout",
  "Grid",
  "Stack",
  "Box",
  "Flex",
  "Container",
  "Provider",
  "Form",
  "Table",
  "List",
  "Tree",
  "Stepper",
  "Breadcrumb",
  "Pagination",
  "Slider",
  "Calendar",
  "DatePicker",
  "Combobox",
  "Autocomplete",
  "Command",
];

/**
 * Input-family leaf keywords enforce deliberately OMITS (its name heuristic
 * never guesses an input host — a false-positive risk for an enforcing check).
 * A SUGGESTION carries no such risk, so it extends the vocabulary here. Order
 * matters: the more specific `Textarea` precedes `Field`/`Input` so a
 * `SearchTextarea` resolves to `textarea`, not `input`.
 *
 * Each entry also carries whether the guess is CONFIDENT or needs ⚠ `verify`:
 * `Select` maps to `select` but is FLAGGED — a "Select" in a design system is
 * frequently a custom combobox (a `<div role="combobox">`), not a native
 * `<select>` — so we suggest the host yet ask the user to confirm.
 */
const INPUT_KEYWORDS: ReadonlyArray<{
  readonly keyword: string;
  readonly host: string;
  readonly confidence: SuggestConfidence;
  readonly reason: string | null;
}> = [
  { keyword: "Textarea", host: "textarea", confidence: "confident", reason: null },
  { keyword: "TextArea", host: "textarea", confidence: "confident", reason: null },
  { keyword: "TextField", host: "input", confidence: "confident", reason: null },
  { keyword: "TextInput", host: "input", confidence: "confident", reason: null },
  { keyword: "Input", host: "input", confidence: "confident", reason: null },
  { keyword: "Field", host: "input", confidence: "confident", reason: null },
  {
    keyword: "Select",
    host: "select",
    confidence: "verify",
    reason: "could be a custom widget, not a native <select>",
  },
];

/**
 * Anchor/image leaf keywords enforce's `Link`/`Image` heuristic doesn't spell
 * out (it matches `Link`/`Image` suffixes; these are the design-system aliases).
 * `Anchor` → `a`; `Avatar`/`Img` → `img`.
 */
const EXTRA_KEYWORDS: ReadonlyArray<{ readonly keyword: string; readonly host: string }> = [
  { keyword: "Anchor", host: "a" },
  { keyword: "Avatar", host: "img" },
  { keyword: "Img", host: "img" },
];

/** Map an enforce {@link ControlType} to the HTML host it denotes for suggesting. */
const TYPE_TO_HOST: Readonly<Record<ControlType, string | null>> = {
  button: "button",
  "icon-button": "button",
  link: "a",
  image: "img",
  input: "input",
  // A dialog is a composite — no single host. Never suggested (caught earlier as
  // a composite name); mapped to `null` here so the type is exhaustive.
  dialog: null,
};

/** Whether `leaf` equals or ends with `keyword` (suffix match, never prefix). */
function matchesKeyword(leaf: string, keyword: string): boolean {
  return leaf === keyword || leaf.endsWith(keyword);
}

/**
 * Guess a host for a single leaf name, or `null` when the name is a composite /
 * toggle / unrecognized (no host to suggest). Precedence is by certainty:
 *
 *   1. toggle  → skip (externally labelled; enforce skips them too).
 *   2. composite → skip (multi-element widget, no single host).
 *   3. input family → `input` / `textarea` / `select` (with a ⚠ for `Select`).
 *   4. anchor / image aliases → `a` / `img`.
 *   5. enforce's control-type heuristic → button / link / image (reused).
 */
function guessHost(name: string): Omit<ComponentSuggestion, "name" | "module"> | null {
  const leaf = leafName(name);

  // Toggles are externally labelled — enforce skips them, so does suggestion.
  if (TOGGLE_NAMES.has(leaf)) return null;

  // Composite widget — no single host. Leave it in declare.
  if (COMPOSITE_KEYWORDS.some((k) => matchesKeyword(leaf, k))) return null;

  // Input family (enforce omits these; a suggestion can safely propose them).
  for (const { keyword, host, confidence, reason } of INPUT_KEYWORDS) {
    if (matchesKeyword(leaf, keyword)) return { host, confidence, reason };
  }

  // Anchor / image aliases enforce's Link/Image suffix doesn't name explicitly.
  for (const { keyword, host } of EXTRA_KEYWORDS) {
    if (matchesKeyword(leaf, keyword)) return { host, confidence: "confident", reason: null };
  }

  // Reuse enforce's name heuristic for button / icon-button / link / image.
  const type = typeFromName(name);
  if (type === null) return null;
  const host = TYPE_TO_HOST[type];
  if (host === null) return null; // dialog → composite, no host
  return { host, confidence: "confident", reason: null };
}

/**
 * Whether a declare-bucket resolution is in scope for suggesting: it must come
 * from an EXTERNAL, non-framework module. Own code (`./`, `@/`, `~`, `#`,
 * tsconfig-alias own source) is one-off app components, not a design system;
 * framework primitives (`next`, `react`, …) are the platform, not a UI library.
 * Mirrors the same two gates `detect-stack.detectDesignSystem` applies.
 */
function inScope(r: ComponentResolution, isOwnAlias: (s: string) => boolean): boolean {
  if (isOwnModule(r.module, isOwnAlias)) return false;
  return !isFrameworkPrimitive(packageNameOf(r.module));
}

/**
 * Suggest a `components` map from the resolution set: take the DECLARE-bucket
 * components (genuine unknowns — `provenance === "opaque"`, `opaqueKind ===
 * "declare"`), scope them to external non-framework modules, and guess a host
 * for each from its NAME. Composites and toggles are left in declare (no single
 * host); everything else yields a suggestion, ⚠-flagged when uncertain.
 *
 * Pure — no disk, no detection. The caller supplies the own-code matcher and the
 * detected design system; the function does the name reasoning. Each suggestion
 * is keyed by the wrapper's LEAF name (the same key the declared-host lookup
 * uses), deduped so a wrapper used in many files yields one suggestion, and
 * sorted for a deterministic report: design-system suggestions first, then by
 * name.
 */
export function suggestComponentMap(
  resolutions: readonly ComponentResolution[],
  opts: SuggestOptions,
): SuggestResult {
  const designSystem =
    opts.designSystem === null || opts.designSystem === "custom" ? null : opts.designSystem;

  const suggestions: ComponentSuggestion[] = [];
  const skipped = new Set<string>();
  const seen = new Set<string>();

  for (const r of resolutions) {
    // Only genuine unknowns are candidates — the design-system primitives the
    // checker could not resolve. trusted / icons / structural are NOT gaps.
    if (r.provenance !== "opaque" || r.opaqueKind !== "declare") continue;
    if (!inScope(r, opts.isOwnAlias)) continue;

    // Key the suggestion by the LEAF name — the SAME key the declared-host
    // lookup in `resolveComponents` uses (`jsxKeyFor`). A namespace render
    // (`CommandPrimitive.Input`) is matched on its trailing member, so the
    // scaffolded `components` entry must be `{ "Input": "input" }` to take
    // effect, not `{ "CommandPrimitive.Input": ... }` which would never match.
    const key = leafName(r.name);

    // Dedupe by the map key so a wrapper used widely is suggested once.
    if (seen.has(key)) continue;
    seen.add(key);

    const guess = guessHost(r.name);
    if (guess === null) {
      // Composite or toggle — no single host; it stays in the declare bucket.
      skipped.add(key);
      continue;
    }
    suggestions.push({ name: key, module: r.module, ...guess });
  }

  // Design-system suggestions first, then alphabetical — deterministic output.
  // `designSystem` is the DETECTED label, which is collapsed to a family name for
  // known multi-package families (`@radix-ui/react-checkbox` -> `Radix`), so the
  // suggestion's package is run through the SAME collapse before comparing —
  // otherwise a Radix app's per-component packages would never match `Radix` and
  // the design-system-first sort would silently regress.
  const rank = (s: ComponentSuggestion): number =>
    designSystem !== null && familyLabel(packageNameOf(s.module)) === designSystem ? 0 : 1;
  suggestions.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));

  return {
    suggestions,
    skipped: [...skipped].sort((a, b) => a.localeCompare(b)),
  };
}
