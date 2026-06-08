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
import { familyLabel, isFrameworkPrimitive, isOwnModule, packageNameOf } from "./module-scope";
import { resolveComponents } from "./resolve-components";
import { ownAliasMatcherFor } from "./tsconfig-aliases";

// Re-export the shared module-scoping rules so existing importers of
// `packageNameOf` from this module keep working; the rules now live in
// `module-scope.ts` so `suggest.ts` shares them without a circular import.
export { isFrameworkPrimitive, isOwnModule, packageNameOf } from "./module-scope";

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
 * The winning package is then collapsed to its canonical FAMILY name for the
 * human-facing label via {@link familyLabel}: a Radix app's dominant package is
 * some per-component sub-package (`@radix-ui/react-checkbox`), but the reported
 * design system is `Radix`. Single-package design systems (`bootstrap`) and
 * workspace packages (`@acme/ui`) pass through unchanged. The collapse is the
 * label only — it does not affect trusted-library resolution, which keys off the
 * raw module specifier in `registry.ts`.
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

  const winner = pickMax(resolvedHost) ?? pickMax(rawUsage);
  // Collapse a known multi-package family (Radix, MUI, …) to its canonical name
  // for the human-facing label; an unknown/single-package DS passes through.
  return winner === null ? "custom" : familyLabel(winner);
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
