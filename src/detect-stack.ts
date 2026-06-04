/**
 * Generic stack detection for any customer repo — never hardcoded to one
 * design system. Three independent signals, each boundary-parsed:
 *
 *   - framework + router : `package.json` deps + `app/` vs `pages/` on disk
 *   - designSystem       : the dominant component-source MODULE across all
 *                          resolved wrappers (registry + traced), so the team's
 *                          actual UI library wins regardless of which one it is
 *   - language           : tsconfig presence
 *
 * The design-system signal reuses `resolveComponents` (the same map the scanner
 * builds) so detection and scanning agree on what a "component import" is.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Language, Router, Stack } from "./contract";
import { resolveComponents } from "./resolve-components";
import { ownAliasMatcherFor } from "./tsconfig-aliases";

/**
 * Walk UP from `dir` (inclusive) to the nearest ancestor containing `marker`,
 * stopping at the filesystem root. Returns that directory, or `null` when no
 * ancestor has it. This is package-up semantics: a scan pointed at a nested
 * `src/` still finds the app's `package.json` / `tsconfig.json` one or more
 * levels above, so framework/language detection doesn't silently degrade to
 * "unknown".
 */
function findUp(dir: string, marker: string): string | null {
  let cur = dir;
  for (;;) {
    if (existsSync(join(cur, marker))) return cur;
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/** A `package.json`'s merged dependency names — the only fields we read. */
interface PackageDeps {
  readonly all: ReadonlyMap<string, string>;
}

/**
 * Read and boundary-parse a `package.json` into its merged dep map. A missing
 * file yields an empty map (not every repo has one at the scanned root); a
 * present-but-malformed file also degrades to empty rather than throwing —
 * stack detection is best-effort signal, not a hard gate.
 */
function readPackageDeps(dir: string): PackageDeps {
  const path = join(dir, "package.json");
  if (!existsSync(path)) return { all: new Map() };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { all: new Map() };
  }
  if (typeof raw !== "object" || raw === null) return { all: new Map() };
  const merged = new Map<string, string>();
  for (const key of ["dependencies", "devDependencies", "peerDependencies"] as const) {
    const section = (raw as Record<string, unknown>)[key];
    if (typeof section !== "object" || section === null) continue;
    for (const [name, version] of Object.entries(section)) {
      if (typeof version === "string") merged.set(name, version);
    }
  }
  return { all: merged };
}

/**
 * Framework detected from a repo's dependency NAMES, with a generic fallback.
 * Exported (taking a name set, not the whole `PackageDeps`) so the ordering
 * rules are unit-testable without a fixture on disk.
 */
export function detectFrameworkFromDeps(names: ReadonlySet<string>): string {
  // Order matters: meta-frameworks before the view library they build on.
  if (names.has("next")) return "next";
  if (names.has("@remix-run/react") || names.has("@remix-run/node")) return "remix";
  // React Router v7 "framework mode" is the Remix successor — it dropped the
  // `@remix-run/*` packages for `@react-router/*` + `react-router`, so a RRv7
  // app (Documenso) would otherwise fall through to the bare `react` label. We
  // gate on the framework-mode packages, NOT bare `react-router`: a plain SPA
  // that uses react-router only for client routing is still just `react`.
  if (names.has("@react-router/node") || names.has("@react-router/serve")) {
    return "react-router";
  }
  if (names.has("astro")) return "astro";
  if (names.has("gatsby")) return "gatsby";
  if (names.has("@angular/core")) return "angular";
  if (names.has("vue")) return "vue";
  if (names.has("svelte")) return "svelte";
  if (names.has("react")) return "react";
  return "unknown";
}

/** Framework detected from deps, with a generic fallback. */
function detectFramework(deps: PackageDeps): string {
  return detectFrameworkFromDeps(new Set(deps.all.keys()));
}

/**
 * Next router from on-disk layout: `app/` (or `src/app/`) is the App Router,
 * `pages/` (or `src/pages/`) is the Pages Router. Only meaningful for Next —
 * `null` for every other framework. App wins if both exist (incremental
 * migrations keep `pages/` around).
 */
function detectRouter(dir: string, framework: string): Router {
  if (framework !== "next") return null;
  const hasApp = existsSync(join(dir, "app")) || existsSync(join(dir, "src", "app"));
  if (hasApp) return "app";
  const hasPages = existsSync(join(dir, "pages")) || existsSync(join(dir, "src", "pages"));
  if (hasPages) return "pages";
  return null;
}

/** Language from tsconfig presence at or above the scanned dir (package-up). */
function detectLanguage(dir: string): Language {
  return findUp(dir, "tsconfig.json") !== null ? "ts" : "js";
}

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
function isOwnModule(specifier: string, ownAlias?: (s: string) => boolean): boolean {
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

function isFrameworkPrimitive(pkg: string): boolean {
  return FRAMEWORK_PRIMITIVES.has(pkg);
}

/**
 * The repo's design system: the published package that contributes the most
 * components RESOLVING TO A KNOWN INTERACTIVE HOST (registry or traced). That
 * is what a design system *is* for a11y purposes — it wraps form/interactive
 * primitives. Ranking on resolved-host count (not raw usage) is what keeps an
 * icon library from winning: icons are opaque (no host) and drop out, even
 * when imported at far more call sites than the real UI library.
 *
 * Fallbacks, in order:
 *   1. most resolved-host wrappers among external packages (the real signal)
 *   2. if nothing resolves, most-used external package by raw usage (so a repo
 *      whose wrappers are all opaque still names its dominant library)
 *   3. `"custom"` when no external package is used at all
 *
 * Ties break by package name for determinism. Own-code modules (relative
 * imports + path aliases) and framework primitives (`next`, `react`, ...) never
 * count — the design system is the UI-component package, not the platform.
 *
 * `rootDir` is where the repo's tsconfig is found (find-up), so its
 * `compilerOptions.paths` aliases that map into own source are excluded too. It
 * defaults to the directory of the first scanned file — find-up climbs from
 * there to the governing tsconfig.
 */
export function detectDesignSystem(tsxFiles: readonly string[], rootDir?: string): string {
  if (tsxFiles.length === 0) return "custom";
  const from = rootDir ?? dirname(tsxFiles[0] ?? ".");
  const ownAlias = ownAliasMatcherFor(from).isOwnAlias;
  const { resolutions } = resolveComponents(tsxFiles);
  const resolvedHost = new Map<string, number>();
  const rawUsage = new Map<string, number>();
  for (const r of resolutions) {
    if (isOwnModule(r.module, ownAlias)) continue; // own component, not a library
    const pkg = packageNameOf(r.module);
    if (isFrameworkPrimitive(pkg)) continue; // platform primitive, not a design system
    rawUsage.set(pkg, (rawUsage.get(pkg) ?? 0) + 1);
    if (r.host !== null) resolvedHost.set(pkg, (resolvedHost.get(pkg) ?? 0) + 1);
  }

  const pickMax = (counts: ReadonlyMap<string, number>): string | null => {
    let best: { pkg: string; n: number } | null = null;
    for (const [pkg, n] of counts) {
      if (best === null || n > best.n || (n === best.n && pkg < best.pkg)) {
        best = { pkg, n };
      }
    }
    return best === null ? null : best.pkg;
  };

  return pickMax(resolvedHost) ?? pickMax(rawUsage) ?? "custom";
}

/**
 * Detect the full stack for a repo rooted at `dir`, given its scannable `.tsx`
 * files (the same set the checker scans). Each field is independent best-effort
 * signal; see the per-field helpers for what each reads.
 */
export function detectStack(dir: string, tsxFiles: readonly string[]): Stack {
  // Package-up: a scan pointed at a nested `src/` finds the app's package.json
  // (and the on-disk app/pages layout) one or more levels above.
  const pkgRoot = findUp(dir, "package.json") ?? dir;
  const deps = readPackageDeps(pkgRoot);
  const framework = detectFramework(deps);
  return {
    framework,
    router: detectRouter(pkgRoot, framework),
    designSystem: detectDesignSystem(tsxFiles, dir),
    language: detectLanguage(dir),
  };
}
