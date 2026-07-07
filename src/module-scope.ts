/**
 * Module-specifier scoping — the shared rules for deciding what a "component
 * import" is OURS vs an external library, used by both stack detection
 * (`detect-stack.ts`) and the `init --suggest` host-guesser (`suggest.ts`).
 *
 * A design system is the PUBLISHED package that supplies a repo's UI components.
 * Two things are NOT a design system and must be excluded everywhere we reason
 * about "which library is this":
 *
 *   - own code  — relative imports + the conventional source aliases (`@/`, `~`,
 *                 `#`) + any tsconfig `paths` alias mapping into own source.
 *                 These are the team's one-off components.
 *   - framework primitives — `next`/`react`/… whose component-like exports
 *                 (`next/link`, `next/image`) are platform plumbing, not UI.
 *
 * Keeping these rules in one module means detection and suggestion agree byte
 * for byte on what counts as an external library — change the rule once, both
 * follow.
 */

/**
 * Reduce a module specifier to its package name so per-component sub-paths
 * collapse onto one library: `@mui/material/Button` -> `@mui/material`,
 * `@radix-ui/react-label` -> `@radix-ui/react-label` (scoped pkg kept whole),
 * `next/link` -> `next`. Relative imports (`./`, `../`) are the repo's OWN
 * components — they are not a design system and are excluded by the caller.
 */
export function packageNameOf(specifier: string): string {
  const parts = specifier.split("/");
  if (specifier.startsWith("@")) {
    // Scoped: keep "@scope/name", drop deeper sub-paths.
    return parts.slice(0, 2).join("/");
  }
  return parts[0] ?? specifier;
}

/**
 * Known multi-package design-system FAMILIES, keyed by the scope (or bare
 * package) a {@link packageNameOf} result starts with, mapped to the canonical
 * human-facing family name.
 *
 * Radix (and MUI, Headless UI, …) ship one npm package PER component
 * (`@radix-ui/react-checkbox`, `@radix-ui/react-dialog`, …). {@link packageNameOf}
 * keeps a scoped package whole, so the dominant-component ranking in
 * `detectDesignSystem` returns whichever sub-package won — alphabetically the
 * first, e.g. `@radix-ui/react-checkbox`. That sub-package name is a leaky
 * implementation detail to surface as "the design system"; the team thinks of it
 * as "Radix". This map collapses the sub-package to the family it belongs to.
 *
 * Each entry is `[matcher, canonicalLabel]`. The matcher is matched against the
 * `packageNameOf`-reduced specifier: a scope prefix (`@radix-ui`) collapses every
 * package under it; a bare exact name (`antd`) collapses just that package. This
 * is a deliberate, hand-maintained lookup — NOT a regex — so every family we
 * collapse is an explicit, reviewable decision.
 *
 * Label choices follow each library's own brand: `Radix`, `MUI`, `Chakra UI`,
 * `Headless UI`, `Mantine`, `Ant Design`, `Fluent UI`. (MUI's pre-v5
 * `@material-ui/*` packages collapse to the same `MUI` label, since they are the
 * same library's older namespace.)
 */
const DESIGN_SYSTEM_FAMILIES: ReadonlyArray<readonly [matcher: string, label: string]> = [
  ["@radix-ui", "Radix"],
  ["@mui", "MUI"],
  ["@material-ui", "MUI"],
  ["@chakra-ui", "Chakra UI"],
  ["@headlessui", "Headless UI"],
  ["@mantine", "Mantine"],
  ["@ant-design", "Ant Design"],
  ["antd", "Ant Design"],
  ["@fluentui", "Fluent UI"],
];

/**
 * Collapse a detected design-system PACKAGE (already reduced by
 * {@link packageNameOf}) to its canonical family name when it belongs to a known
 * multi-package family ({@link DESIGN_SYSTEM_FAMILIES}); otherwise return it
 * unchanged. So `@radix-ui/react-checkbox` -> `Radix`, but a single-package
 * design system like `bootstrap` or a workspace package like `@acme/ui` passes
 * through verbatim.
 *
 * This is the HUMAN-FACING label only — the reported/written
 * `Stack.designSystem`. It does NOT drive trusted-library resolution (that keys
 * off the raw module specifier in `registry.ts`, never off this label), so
 * collapsing the label here cannot regress the `trusted` bucket. The one
 * label-sensitive consumer, `suggest.ts`'s design-system-first sort, runs the
 * resolution's package through THIS SAME function before comparing — so the sort
 * still matches when the detected label is a collapsed family name.
 */
export function familyLabel(pkg: string): string {
  for (const [matcher, label] of DESIGN_SYSTEM_FAMILIES) {
    if (pkg === matcher || pkg.startsWith(`${matcher}/`)) return label;
  }
  return pkg;
}

/**
 * A module specifier that resolves to the repo's OWN code, not an installed
 * package: relative (`./`, `../`), the conventional source aliases (`~/...`,
 * `@/...`, `#...`), and — when an `ownAlias` matcher is supplied — any
 * `compilerOptions.paths` alias whose target maps INTO the repo's own source
 * (Saleor `@dashboard/* -> src/*`, Cal.com `@coss/ui/* -> packages/.../src/*`).
 * These are the team's own components and must never be mistaken for a design
 * system — only published packages count.
 */
export function isOwnModule(specifier: string, ownAlias?: (s: string) => boolean): boolean {
  if (specifier.startsWith(".")) return true;
  if (specifier.startsWith("~") || specifier.startsWith("#")) return true;
  // `@/...` is the common src alias; a real scoped package is `@scope/name`.
  if (specifier.startsWith("@/")) return true;
  // A project alias that maps into own source is own code, even when it LOOKS
  // like a scoped package (`@dashboard/...`, `@coss/ui/...`).
  if (ownAlias?.(specifier) === true) return true;
  return false;
}

/**
 * Framework view/meta-framework PACKAGES whose component-like exports
 * (`next/link`, `next/image`, `react`) are platform primitives, not a design
 * system. A repo's "design system" is the package that supplies its UI
 * COMPONENTS — never the framework it runs on. Excluding these is what stops
 * `next` from winning the ranking just because every page imports `next/link`.
 * Keyed by package name (after {@link packageNameOf}).
 */
const FRAMEWORK_PRIMITIVES: ReadonlySet<string> = new Set([
  "next",
  "react",
  "react-dom",
  "gatsby",
  "@remix-run/react",
  "@remix-run/node",
  "astro",
]);

/** Whether `pkg` (already reduced by {@link packageNameOf}) is a framework primitive. */
export function isFrameworkPrimitive(pkg: string): boolean {
  return FRAMEWORK_PRIMITIVES.has(pkg);
}
