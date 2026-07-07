/**
 * Known-library wrapper -> host-primitive registry.
 *
 * This is the deterministic fast path: for the design systems most customer
 * codebases actually use, we know the wrapper->primitive mapping up front and
 * never need to trace source. Coverage here is pure DATA — adding a library is
 * a new `RegistryRule` entry, never a code change.
 *
 * A rule matches on (import module specifier, imported export name). The
 * specifier is matched as a prefix so scoped sub-paths resolve too
 * (`@mui/material/Button` matches the `@mui/material` rule). `exportName` is
 * the *imported* name as written in source; for namespace/sub-path imports
 * (Radix `* as LabelPrimitive` -> `LabelPrimitive.Root`) the member after the
 * dot is what we match, captured by the resolver as `Root`.
 *
 * Each rule yields the WAI-ARIA / HTML host element name jsx-a11y understands
 * (an intrinsic tag like `input`, `button`, `a`, `label`, `img`, `textarea`,
 * `select`). Components with no single accessible host (Card, Dialog wrappers,
 * layout primitives) are deliberately NOT listed — they should fall through to
 * tracing or land as OPAQUE rather than be mis-mapped.
 */
export interface RegistryRule {
  /** Library display name, for the coverage report / provenance. */
  readonly library: string;
  /** Module specifier prefix, e.g. "@mui/material" or "@radix-ui/react-label". */
  readonly module: string;
  /** Imported export (or namespace member) name, e.g. "Button", "Root", "TextField". */
  readonly exportName: string;
  /** Host primitive this wrapper ultimately renders. */
  readonly host: string;
  /**
   * The explicit ARIA `role` the library sets on that host, when it differs from
   * the host's implicit role — present ONLY for the TOGGLE primitives whose host
   * is `button`/`input` but which render `role="checkbox"|"switch"|"radio"`
   * (Radix `Checkbox`/`Switch`, antd `Switch`). The host alone would read as a
   * bare button/input downstream and fire role-support rules that don't apply to
   * the real role (e.g. `aria-invalid` is invalid on a bare button but valid on
   * `role="checkbox"`). Carrying the role lets the resolver treat it as the
   * toggle it is. Absent ⇒ the host's implicit role; nothing changes.
   */
  readonly role?: string;
}

/**
 * Seed rules for the common stacks. Intentionally conservative: only wrappers
 * with one unambiguous accessible host. Extend by appending rows.
 */
export const REGISTRY: readonly RegistryRule[] = [
  // ---- Radix UI (primitives are per-package; component is usually `Root`) ----
  { library: "Radix", module: "@radix-ui/react-label", exportName: "Root", host: "label" },
  { library: "Radix", module: "@radix-ui/react-label", exportName: "Label", host: "label" },
  // Radix renders these toggles as `<button role="checkbox|switch">` — carry the
  // role so downstream treats them as toggles, not bare buttons (otherwise a
  // `<Checkbox aria-invalid>` fires `role-supports-aria-props` against `button`,
  // a false positive — `aria-invalid` IS valid on `role="checkbox"`).
  {
    library: "Radix",
    module: "@radix-ui/react-checkbox",
    exportName: "Root",
    host: "button",
    role: "checkbox",
  },
  {
    library: "Radix",
    module: "@radix-ui/react-switch",
    exportName: "Root",
    host: "button",
    role: "switch",
  },
  { library: "Radix", module: "@radix-ui/react-toggle", exportName: "Root", host: "button" },
  // Radix Slot is polymorphic (renders its child) — no fixed host, left opaque.

  // ---- MUI (@mui/material) ----
  { library: "MUI", module: "@mui/material", exportName: "Button", host: "button" },
  { library: "MUI", module: "@mui/material", exportName: "IconButton", host: "button" },
  { library: "MUI", module: "@mui/material", exportName: "Link", host: "a" },
  { library: "MUI", module: "@mui/material", exportName: "TextField", host: "input" },
  { library: "MUI", module: "@mui/material", exportName: "InputBase", host: "input" },
  { library: "MUI", module: "@mui/material", exportName: "OutlinedInput", host: "input" },
  { library: "MUI", module: "@mui/material", exportName: "FilledInput", host: "input" },
  { library: "MUI", module: "@mui/material", exportName: "Input", host: "input" },
  { library: "MUI", module: "@mui/material", exportName: "Checkbox", host: "input" },
  { library: "MUI", module: "@mui/material", exportName: "Radio", host: "input" },
  { library: "MUI", module: "@mui/material", exportName: "Switch", host: "input" },
  { library: "MUI", module: "@mui/material", exportName: "TextareaAutosize", host: "textarea" },
  { library: "MUI", module: "@mui/material", exportName: "InputLabel", host: "label" },
  { library: "MUI", module: "@mui/material", exportName: "FormLabel", host: "label" },
  { library: "MUI", module: "@mui/material", exportName: "Select", host: "select" },

  // ---- MUI v4 (@material-ui/core) — same component->host mapping as v5, just
  //      the pre-v5 package namespace. Repos that haven't migrated (Saleor)
  //      import the identical exports from here. ----
  { library: "MUI", module: "@material-ui/core", exportName: "Button", host: "button" },
  { library: "MUI", module: "@material-ui/core", exportName: "IconButton", host: "button" },
  { library: "MUI", module: "@material-ui/core", exportName: "Link", host: "a" },
  { library: "MUI", module: "@material-ui/core", exportName: "TextField", host: "input" },
  { library: "MUI", module: "@material-ui/core", exportName: "InputBase", host: "input" },
  { library: "MUI", module: "@material-ui/core", exportName: "OutlinedInput", host: "input" },
  { library: "MUI", module: "@material-ui/core", exportName: "FilledInput", host: "input" },
  { library: "MUI", module: "@material-ui/core", exportName: "Input", host: "input" },
  { library: "MUI", module: "@material-ui/core", exportName: "Checkbox", host: "input" },
  { library: "MUI", module: "@material-ui/core", exportName: "Radio", host: "input" },
  { library: "MUI", module: "@material-ui/core", exportName: "Switch", host: "input" },
  { library: "MUI", module: "@material-ui/core", exportName: "TextareaAutosize", host: "textarea" },
  { library: "MUI", module: "@material-ui/core", exportName: "InputLabel", host: "label" },
  { library: "MUI", module: "@material-ui/core", exportName: "FormLabel", host: "label" },
  { library: "MUI", module: "@material-ui/core", exportName: "Select", host: "select" },

  // ---- Chakra UI (@chakra-ui/react) ----
  { library: "Chakra", module: "@chakra-ui/react", exportName: "Button", host: "button" },
  { library: "Chakra", module: "@chakra-ui/react", exportName: "IconButton", host: "button" },
  { library: "Chakra", module: "@chakra-ui/react", exportName: "Link", host: "a" },
  { library: "Chakra", module: "@chakra-ui/react", exportName: "Input", host: "input" },
  { library: "Chakra", module: "@chakra-ui/react", exportName: "Checkbox", host: "input" },
  { library: "Chakra", module: "@chakra-ui/react", exportName: "Radio", host: "input" },
  { library: "Chakra", module: "@chakra-ui/react", exportName: "Switch", host: "input" },
  { library: "Chakra", module: "@chakra-ui/react", exportName: "Textarea", host: "textarea" },
  { library: "Chakra", module: "@chakra-ui/react", exportName: "Select", host: "select" },
  { library: "Chakra", module: "@chakra-ui/react", exportName: "FormLabel", host: "label" },
  { library: "Chakra", module: "@chakra-ui/react", exportName: "Image", host: "img" },

  // ---- Ant Design (antd) ----
  // Only the single-identifier leaf controls whose host is unambiguous. antd's
  // COMPOUND members (`Input.Search`, `Input.Password`, `Input.TextArea`,
  // `Radio.Button`, `Typography.Link`) are deliberately absent: a named import
  // (`import { Input } from "antd"`) collapses `Input.Search` to a lookup on
  // `Input`, while the jsx-a11y map keys it by its LEAF (`Search`) — so mapping
  // the namespace root would lend a wrong host to every `<Search>`/`<Password>`/
  // `<Link>` in the tree. Those, plus the custom-combobox controls (`Select`,
  // `DatePicker`, `TimePicker` — div-based, NOT native `<select>`/`<input>`) and
  // `Avatar` (a `<span>` unless `src` is set), fall through to `guaranteedBy`.
  { library: "Antd", module: "antd", exportName: "Button", host: "button" },
  { library: "Antd", module: "antd", exportName: "Input", host: "input" },
  { library: "Antd", module: "antd", exportName: "InputNumber", host: "input" },
  { library: "Antd", module: "antd", exportName: "Checkbox", host: "input" },
  { library: "Antd", module: "antd", exportName: "Radio", host: "input" },
  // antd `Switch` renders a `<button role="switch">` (rc-switch), like Radix —
  // not the `<input>` MUI/Chakra use. enforce SKIPS toggles (TOGGLE_NAMES); the
  // `role` keeps the structural jsx-a11y pass from reading it as a bare button.
  { library: "Antd", module: "antd", exportName: "Switch", host: "button", role: "switch" },
  { library: "Antd", module: "antd", exportName: "Image", host: "img" },

  // ---- Medusa UI (@medusajs/ui) ----
  // Single-host leaf primitives only. `Button`/`IconButton` render a `<button>`
  // (the `asChild` Slot form is polymorphic, but the default host is `button`,
  // matching the registered MUI/Chakra `IconButton`). `Input` wraps a single
  // `<input>` in a layout `<div>` with optional decorative search/password
  // affordances — the accessible control is the one input, exactly the MUI
  // `TextField` shape already mapped to `input`. `Textarea` -> `<textarea>`.
  // `Checkbox`/`Switch` are Radix primitives under the hood, so (like Radix/antd)
  // they render `<button role="checkbox|switch">` — carry the toggle role so the
  // host doesn't read as a bare button and fire role-support rules that don't
  // apply to the real role.
  //
  // DELIBERATELY ABSENT: `Select` (a Radix-Select custom combobox — renders a
  // `<button>` + a popover of divs, NOT a native `<select>`, the antd `Select`
  // lesson), `RadioGroup` (a composite of radios, no single host), and every
  // compound / value component (`Table`, `Badge`, `IconBadge`, `Container`,
  // `Heading`, `Text`, `Label`, `Toaster`) — none is one unambiguous interactive
  // host. The library is marked guaranteed below so these stay TRUSTED.
  { library: "Medusa", module: "@medusajs/ui", exportName: "Button", host: "button" },
  { library: "Medusa", module: "@medusajs/ui", exportName: "IconButton", host: "button" },
  { library: "Medusa", module: "@medusajs/ui", exportName: "Input", host: "input" },
  { library: "Medusa", module: "@medusajs/ui", exportName: "Textarea", host: "textarea" },
  {
    library: "Medusa",
    module: "@medusajs/ui",
    exportName: "Checkbox",
    host: "button",
    role: "checkbox",
  },
  {
    library: "Medusa",
    module: "@medusajs/ui",
    exportName: "Switch",
    host: "button",
    role: "switch",
  },

  // ---- Headless UI (@headlessui/react) ----
  // Headless UI v2 exposes FLAT leaf exports for the bare-control primitives;
  // each is documented as "a light wrapper around the native <X> element".
  // `Button` -> `<button>`, `Input` -> `<input>`, `Textarea` -> `<textarea>`,
  // `Select` -> a native `<select>` (NOT a div combobox — that is `Listbox`, a
  // separate composite). `Switch` renders a `<button>` with switch semantics, so
  // it carries `role="switch"` like Radix/antd/Medusa.
  //
  // DELIBERATELY ABSENT: every COMPOSITE — `Menu`, `Listbox`, `Combobox`,
  // `Tab`/`TabGroup`, `Disclosure`, `RadioGroup`, `Dialog`, `Popover`,
  // `Transition` — is a bundle of elements with no single host. Their dot-members
  // (`Menu.Button`, `Dialog.Panel`, `Transition.Child`, `PopoverPanel`, …) are
  // also out: a named import (`import { Menu }`) collapses `Menu.Button` to a
  // lookup on `Menu`, and the jsx-a11y map keys by the LEAF (`Button`), so
  // mapping the root would lend a wrong host to every leaf — the antd compound
  // lesson. The library is marked guaranteed below so these stay TRUSTED.
  { library: "HeadlessUI", module: "@headlessui/react", exportName: "Button", host: "button" },
  { library: "HeadlessUI", module: "@headlessui/react", exportName: "Input", host: "input" },
  {
    library: "HeadlessUI",
    module: "@headlessui/react",
    exportName: "Textarea",
    host: "textarea",
  },
  { library: "HeadlessUI", module: "@headlessui/react", exportName: "Select", host: "select" },
  {
    library: "HeadlessUI",
    module: "@headlessui/react",
    exportName: "Switch",
    host: "button",
    role: "switch",
  },

  // ---- React Aria Components (react-aria-components) ----
  { library: "ReactAria", module: "react-aria-components", exportName: "Button", host: "button" },
  { library: "ReactAria", module: "react-aria-components", exportName: "Link", host: "a" },
  { library: "ReactAria", module: "react-aria-components", exportName: "Input", host: "input" },
  {
    library: "ReactAria",
    module: "react-aria-components",
    exportName: "TextArea",
    host: "textarea",
  },
  { library: "ReactAria", module: "react-aria-components", exportName: "Label", host: "label" },

  // ---- Next.js (very common, technically not a design system) ----
  { library: "Next", module: "next/link", exportName: "default", host: "a" },
  { library: "Next", module: "next/image", exportName: "default", host: "img" },
] as const;

/**
 * A design system whose primitives are accessible BY CONSTRUCTION when used
 * correctly — Radix, MUI, React Aria, Chakra, Mantine. The library owns the
 * internal a11y of these components (roles, focus management, ARIA wiring), so
 * a wrapper that stays OPAQUE to the source-tracer is still trustworthy: the
 * structure is guaranteed even though the checker can't see a single host.
 *
 * This is the reporting counterpart to {@link REGISTRY}: REGISTRY maps the few
 * primitives with ONE unambiguous host (so jsx-a11y can run on them); this list
 * recognizes the WHOLE library so its composite/opaque components (`Dialog`,
 * `HoverCard.Root`, `Tabs`) are reported as TRUSTED rather than as unknown gaps.
 *
 * Pure data: marking a library guaranteed is a new `GuaranteedLibrary` row,
 * never a code change. `guaranteedBy` is always `true` here — the flag exists so
 * the type reads as a deliberate accessibility claim at every call site, not an
 * incidental string match.
 */
export interface GuaranteedLibrary {
  /** Library display name, surfaced in the coverage report's "trusted" line. */
  readonly library: string;
  /**
   * Module specifier prefix. Matched as a prefix so every sub-path resolves:
   * `@radix-ui` covers `@radix-ui/react-hover-card`, `@mui/material` covers
   * `@mui/material/Button`. Use the scope (`@radix-ui`) when EVERY package under
   * it is a primitive; use the package (`@mui/material`) when only that one is.
   */
  readonly module: string;
  /** Always `true` — present so the accessibility guarantee is explicit data. */
  readonly guaranteedBy: true;
}

/**
 * The known-accessible design systems. A component imported from any of these
 * is TRUSTED even when opaque: the library guarantees its internal structure.
 *
 * Scope-wide entries (`@radix-ui`, `@chakra-ui`, `@mantine`) are safe because
 * every published package under those scopes is a UI primitive from that one
 * library. Package-level entries (`@mui/material`, `@material-ui/core`,
 * `react-aria-components`) name the exact component package, not the scope,
 * because the scope also carries non-primitive packages (`@mui/system`,
 * `@mui/x-*`) we don't want to vouch for.
 */
export const GUARANTEED_LIBRARIES: readonly GuaranteedLibrary[] = [
  // Radix: every @radix-ui/react-* package is an accessible primitive.
  { library: "Radix", module: "@radix-ui", guaranteedBy: true },
  // MUI v5 + v4 component packages (the scope also has @mui/system etc., so pin
  // the component package, not the scope).
  { library: "MUI", module: "@mui/material", guaranteedBy: true },
  { library: "MUI", module: "@material-ui/core", guaranteedBy: true },
  // React Aria Components — the single accessible-components package.
  { library: "ReactAria", module: "react-aria-components", guaranteedBy: true },
  // Chakra + Mantine: scope-wide, every package is the design system's UI.
  { library: "Chakra", module: "@chakra-ui", guaranteedBy: true },
  { library: "Mantine", module: "@mantine", guaranteedBy: true },
  // Ant Design — the single `antd` package. NOT the `@ant-design` scope: that
  // also carries `@ant-design/icons` (an SVG pack, matched in ICON_LIBRARIES)
  // and `@ant-design/pro-components` (heavier composites), neither of which is
  // the core accessible primitive set we vouch for here.
  { library: "Antd", module: "antd", guaranteedBy: true },
  // Medusa UI — the single `@medusajs/ui` package (Radix-based primitives with
  // a11y owned by the library). NOT the `@medusajs` scope: that also carries
  // `@medusajs/icons` (an SVG pack, matched in ICON_LIBRARIES) and many non-UI
  // packages (`@medusajs/js-sdk`, `@medusajs/types`, …) we don't vouch for.
  { library: "Medusa", module: "@medusajs/ui", guaranteedBy: true },
  // Headless UI — the single `@headlessui/react` package; every export is an
  // accessible-by-construction primitive of this one design system.
  { library: "HeadlessUI", module: "@headlessui/react", guaranteedBy: true },
  // cmdk — the command-menu primitive (`Command`, `Command.Input/List/Item/…`)
  // shadcn's `command.tsx` wraps. An accessible-by-construction combobox/listbox;
  // the single `cmdk` package, every export a primitive of this one library.
  { library: "cmdk", module: "cmdk", guaranteedBy: true },
] as const;

/**
 * The library name that GUARANTEES the accessibility of a component imported
 * from `moduleSpecifier`, or `null` when the module is not a known-accessible
 * design system. Prefix-matched like {@link lookupRegistry}, so scoped sub-paths
 * resolve against the library entry. This is what splits OPAQUE into "trusted"
 * (from a guaranteed library) vs "declare" (genuinely unknown) for the report —
 * it changes NO checking behavior, only how an opaque component is bucketed.
 */
export function lookupGuaranteed(moduleSpecifier: string): string | null {
  for (const lib of GUARANTEED_LIBRARIES) {
    if (moduleSpecifier === lib.module || moduleSpecifier.startsWith(`${lib.module}/`)) {
      return lib.library;
    }
  }
  return null;
}

/**
 * Icon libraries: components that render an `<svg>`, which has NO interactive
 * accessible host. There is nothing for jsx-a11y to check at the call site (an
 * icon's accessibility is decided by its consumer — the button or link that
 * labels it), so these must NOT land in the "declare" bucket as if a host
 * declaration would help. They are surfaced as a separate "no interactive host"
 * note: opaque-but-not-actionable.
 *
 * Pure data, prefix-matched. Add a row to recognize another icon pack.
 */
export const ICON_LIBRARIES: readonly string[] = [
  "lucide-react",
  "@heroicons/react",
  "react-icons",
  "@tabler/icons-react",
  "@phosphor-icons/react",
  "@radix-ui/react-icons",
  "react-feather",
  // Design-system icon packs. Each is the SVG sibling of a guaranteed library —
  // matched HERE (not as a guaranteed primitive) so its imports read as `icons`,
  // not `trusted`. `@ant-design/icons` in particular must be checked before the
  // `antd` guarantee would otherwise be tempted to claim it.
  "@ant-design/icons",
  "@mui/icons-material",
  "@chakra-ui/icons",
  // Medusa's SVG icon pack — sibling of the guaranteed `@medusajs/ui`. Matched
  // HERE so its imports read as `icons`, not as trusted primitives.
  "@medusajs/icons",
] as const;

/**
 * Whether `moduleSpecifier` is a known icon library — an SVG-only package with
 * no interactive host to check. Prefix-matched like the other lookups. Note
 * `@radix-ui/react-icons` is an icon pack, NOT an accessible primitive, so it is
 * matched HERE; {@link lookupGuaranteed}'s `@radix-ui` entry would otherwise
 * claim it as trusted, so icon classification must be checked FIRST.
 */
export function isIconLibrary(moduleSpecifier: string): boolean {
  return ICON_LIBRARIES.some(
    (lib) => moduleSpecifier === lib || moduleSpecifier.startsWith(`${lib}/`),
  );
}

/**
 * STRUCTURAL plumbing recognition — components that render nothing interactive
 * (or nothing at all): they wire up context, lay out routes, draw a chart, or
 * compose an email. Like an icon library, a structural component has NO
 * interactive accessible host to check, so counting it as a `declare` gap
 * manufactures a false to-do. This data backs {@link isStructural}, which
 * {@link resolveComponents} consults BEFORE the trusted/declare split so the
 * coverage report doesn't paint plumbing as an actionable unknown.
 *
 * CONSERVATIVE BY CONSTRUCTION. A false "structural" HIDES a real gap, so every
 * rule below is either a framework-level certainty (React `Fragment`) or an
 * allowlisted export from a KNOWN module — never a broad guess. The one risk a
 * structural rule must never take is swallowing a CONTROL: `Link`/`NavLink`
 * render `<a>` and are deliberately ABSENT from every router allowlist here.
 */

/**
 * Framework structural names recognized regardless of module — React's own
 * non-rendering composition primitives. `Fragment` (and the `React.Fragment`
 * namespace form, keyed on its leaf), `Suspense`, `StrictMode`, `Profiler`:
 * none renders a host element. Matched on the LEAF name so both the named
 * (`<Fragment>`) and namespace (`<React.Fragment>`) spellings resolve.
 */
const STRUCTURAL_FRAMEWORK_NAMES: ReadonlySet<string> = new Set([
  "Fragment",
  "Suspense",
  "StrictMode",
  "Profiler",
]);

/**
 * Router modules whose STRUCTURAL exports lay out the route tree / document but
 * render no interactive control. Recognition is an explicit allowlist of export
 * NAMES (below), gated to these modules — so a same-named export elsewhere is
 * unaffected, and (critically) the CONTROLS these same modules export — `Link`,
 * `NavLink` (both render `<a>`) — are simply absent from the allowlist and stay
 * classified as the controls they are.
 */
const ROUTER_MODULES: readonly string[] = [
  "react-router",
  "react-router-dom",
  "@remix-run/react",
  // umi re-exports react-router's structural exports under its own module
  // (antd-pro's `Outlet` comes from here). The name allowlist still gates it:
  // umi's `Link` / `SelectLang` / `FormattedMessage` are NOT structural names,
  // so they stay in `declare` as before.
  "@umijs/max",
];

/**
 * The STRUCTURAL export names of the router modules in {@link ROUTER_MODULES}:
 * route-tree layout (`Routes`/`Route`/`Outlet`/`Navigate`/`RouterProvider` and
 * the `*Router` history providers) and the Remix/RRv7 document components
 * (`Meta`/`Links`/`Scripts`/`ScrollRestoration`/`LiveReload`, plus the server/
 * hydration entry components). `Link`/`NavLink` are POINTEDLY excluded — they
 * are `<a>` controls, not plumbing. Matched on the leaf name.
 */
const ROUTER_STRUCTURAL_NAMES: ReadonlySet<string> = new Set([
  "Routes",
  "Route",
  "Outlet",
  "Navigate",
  "RouterProvider",
  "BrowserRouter",
  "MemoryRouter",
  "HashRouter",
  "ServerRouter",
  "HydratedRouter",
  "Meta",
  "Links",
  "Scripts",
  "ScrollRestoration",
  "LiveReload",
]);

/**
 * Non-router modules whose every export is structural plumbing — nothing to
 * check at the call site. Prefix-matched like the other lookups. These are the
 * widely-used cases SEEN in the real declare buckets of the validation catalog:
 *
 *   - chart libraries (`recharts`, `@nivo/*`, `@ant-design/plots`,
 *     `@ant-design/charts`) — every export draws an `<svg>`/`<canvas>`; the
 *     a11y of a chart is a data-table/`aria` concern, not a call-site host
 *     check. (antd-pro's declare was full of `@ant-design/plots` `Line`/`Pie`/
 *     `Gauge`/…; react-admin's of `@nivo/bar` `ResponsiveBar`.)
 *   - `@react-email/*` — email document components (`Html`, `Container`,
 *     `Text`, …) compose an email, not an interactive web surface (seen in
 *     Epic Stack's email templates as `E.Html`/`E.Container`/`E.Text`).
 *
 * NOTHING here renders an interactive control; if a future module under one of
 * these prefixes did, it would need to move OUT — conservatism over coverage.
 */
const STRUCTURAL_MODULES: readonly string[] = [
  "recharts",
  "@nivo",
  "@ant-design/plots",
  "@ant-design/charts",
  "@react-email",
  // sonner — the `Toaster` is a transient toast region mounted once at the app
  // root, not an interactive control on the page; its only other export is the
  // imperative `toast()` fn. No host to check → plumbing, not a `declare` gap.
  "sonner",
  // nextjs-toploader — a top-of-page route-progress bar. Renders no interactive
  // control; mounted once at the root, like the toast region above.
  "nextjs-toploader",
  // @next/third-parties — Google Analytics / Tag Manager `<script>` injectors.
  // They mount tracking scripts, not interactive UI; no host to check.
  "@next/third-parties",
];

/** The leaf of a JSX name (`NS.Member` -> `Member`, else the name itself). */
function leafOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? name : name.slice(dot + 1);
}

/**
 * Whether a component used as `name` (the JSX tag, possibly a `NS.Member` form)
 * imported from `moduleSpecifier` is STRUCTURAL plumbing — non-rendering /
 * non-interactive, with no host to check. Recognized when ANY holds:
 *
 *   - the leaf name is a framework primitive ({@link STRUCTURAL_FRAMEWORK_NAMES}):
 *     `Fragment` / `React.Fragment` / `Suspense` / `StrictMode` / `Profiler`;
 *   - the leaf name ENDS WITH `Provider` (`ThemeProvider`, `QueryClientProvider`,
 *     react-admin's `*ContextProvider`, …) — a context provider renders its
 *     children, no host of its own. The namespace `<X.Provider>` form is the
 *     same shape (leaf `Provider`), so it is covered too;
 *   - the leaf name ENDS WITH `ErrorBoundary` (`ErrorBoundary`,
 *     `GeneralErrorBoundary`) — a render-or-fallback wrapper, no fixed host;
 *   - it is a STRUCTURAL export of a router module ({@link ROUTER_MODULES} ×
 *     {@link ROUTER_STRUCTURAL_NAMES}) — route/document layout, NOT `Link`/`NavLink`;
 *   - its module is an all-structural module ({@link STRUCTURAL_MODULES}) —
 *     chart / email packages.
 *
 * CONSERVATIVE: a suffix rule is a SUFFIX (or whole name), never a prefix, so a
 * `ProviderList` / `ErrorBoundaryConfig` container is NOT swept in. When unsure
 * whether something renders a control, it is NOT listed here — it stays in
 * `declare`, where a real gap belongs.
 */
export function isStructural(name: string, moduleSpecifier: string): boolean {
  const leaf = leafOf(name);

  // Framework + name-shape recognition (module-agnostic).
  if (STRUCTURAL_FRAMEWORK_NAMES.has(leaf)) return true;
  // `<X.Provider>` and any `*Provider` name; `*ErrorBoundary`. Whole-name OK,
  // suffix OK, prefix NOT (a container like `ProviderRegistry` is not plumbing).
  if (leaf === "Provider" || leaf.endsWith("Provider")) return true;
  if (leaf.endsWith("ErrorBoundary")) return true;

  // Router structural exports — allowlisted name, gated to a router module.
  const fromRouter = ROUTER_MODULES.some(
    (m) => moduleSpecifier === m || moduleSpecifier.startsWith(`${m}/`),
  );
  if (fromRouter && ROUTER_STRUCTURAL_NAMES.has(leaf)) return true;

  // All-structural modules — chart / email packages, prefix-matched.
  return STRUCTURAL_MODULES.some(
    (m) => moduleSpecifier === m || moduleSpecifier.startsWith(`${m}/`),
  );
}

/**
 * Router modules whose `Link` / `NavLink` are `<a>`-rendering LINK CONTROLS (not
 * the structural plumbing in {@link ROUTER_STRUCTURAL_NAMES}). They render an
 * anchor, but the destination rides a `to` prop — NOT `href` — so they are
 * pointedly kept OUT of the jsx-a11y component map: the structural
 * `anchor-is-valid` rule reads a missing `href` literally and would false-
 * positive on every `<Link to=…>`. Recognition therefore lives only in the
 * content pass (enforce), where the check is NAME-based, not href-based: an
 * icon-only `<Link to><Icon/></Link>` with no accessible name is the real 2.4.4
 * it always was. Scoped to the genuine react-router / Remix packages — NOT
 * `@umijs/max`, whose `Link` is a distinct re-export we don't vouch for.
 */
const ROUTER_LINK_MODULES: readonly string[] = [
  "react-router",
  "react-router-dom",
  "@remix-run/react",
];

/** The router link CONTROL export names (render `<a>`), matched on the leaf. */
const ROUTER_LINK_NAMES: ReadonlySet<string> = new Set(["Link", "NavLink"]);

/**
 * Whether `exportName` imported from `moduleSpecifier` is a react-router / Remix
 * link control (`Link` / `NavLink`). Consumed ONLY by the enforce content pass —
 * never by `resolveComponents`, so these never enter the structural jsx-a11y map
 * (see {@link ROUTER_LINK_MODULES} for why that separation matters). Module is
 * matched exactly or as a sub-path (`react-router/dom`), name on its leaf.
 */
export function isRouterLinkControl(moduleSpecifier: string, exportName: string): boolean {
  const fromRouterLinkModule = ROUTER_LINK_MODULES.some(
    (m) => moduleSpecifier === m || moduleSpecifier.startsWith(`${m}/`),
  );
  return fromRouterLinkModule && ROUTER_LINK_NAMES.has(leafOf(exportName));
}

/**
 * ARIA roles that make an otherwise button/input host a TOGGLE — externally
 * labelled, so the same "uncertain → skip" rule that exempts {@link
 * TOGGLE_NAMES} applies. When a resolved host carries one of these (Radix
 * Checkbox `role="checkbox"`, a homegrown `<button role="switch">`), it must be
 * treated as a toggle, not a bare button/input: kept out of the jsx-a11y map
 * (so role-support rules for the bare host don't fire) and skipped by enforce.
 * NON-toggle roles are NOT here — they change nothing (a `role="tab"` host still
 * gets its normal treatment), keeping the suppression tight.
 */
export const TOGGLE_ROLES: ReadonlySet<string> = new Set([
  "checkbox",
  "switch",
  "radio",
  "menuitemcheckbox",
  "menuitemradio",
]);

/** Whether `role` is a toggle role — the role-aware analogue of `TOGGLE_NAMES`. */
export function isToggleRole(role: string | null | undefined): boolean {
  return role !== null && role !== undefined && TOGGLE_ROLES.has(role);
}

/** A registry hit, carrying provenance for the coverage report. */
export interface RegistryHit {
  readonly host: string;
  readonly library: string;
  /** The library's explicit toggle `role` on the host, when it has one (see {@link RegistryRule.role}). */
  readonly role?: string;
}

/**
 * Look up a registry mapping for a wrapper imported as `exportName` from
 * `moduleSpecifier`. The specifier matches by prefix so scoped sub-paths
 * (`@mui/material/Button`) resolve against the package-level rule. Returns
 * `null` for no match — the caller then falls back to source-tracing.
 */
export function lookupRegistry(moduleSpecifier: string, exportName: string): RegistryHit | null {
  for (const rule of REGISTRY) {
    const moduleMatches =
      moduleSpecifier === rule.module || moduleSpecifier.startsWith(`${rule.module}/`);
    if (moduleMatches && rule.exportName === exportName) {
      return { host: rule.host, library: rule.library, role: rule.role };
    }
  }
  return null;
}
