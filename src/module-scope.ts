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
