/**
 * tsconfig path-alias reader: tell whether an import specifier is the repo's
 * OWN code reached through a `compilerOptions.paths` alias, rather than a
 * third-party design system.
 *
 * Why this exists. Design-system detection ranks the package that contributes
 * the most host-resolving wrappers. A repo that imports its OWN UI through a
 * project alias — Saleor `@dashboard/* -> src/*`, Cal.com `@coss/ui/* ->
 * ../../packages/coss-ui/src/*` — looks like a published `@scope/pkg` to the
 * naive `isOwnModule` check, so the alias wins the ranking over the real
 * third-party library. Semantically an alias that maps INTO the repo's own
 * source is not a design system; it is the team's own components.
 *
 * The signal is the alias TARGET: a target that is a relative path (`src/*`,
 * `../../packages/.../src/*`) points at source the team controls. A target that
 * is itself a bare package name (`@scope/pkg/*`, `node_modules/...`) is a
 * re-pointer to an external dependency and is left alone. We resolve `extends`
 * chains (bounded) and honor `baseUrl`, exactly as the customer's own build
 * does — never a hardcoded per-repo list.
 *
 * Everything is best-effort + boundary-parsed: a missing/malformed tsconfig, an
 * unresolvable `extends`, or a target we can't classify all degrade to "not an
 * own-alias" — the caller then treats the import as a candidate design system,
 * the pre-existing behavior.
 */

import { dirname, resolve, sep } from "node:path";
import ts from "typescript";

/** A compiled alias: the literal prefix of a `paths` key (before any `*`). */
interface AliasPrefix {
  /** The key text up to the `*` (e.g. `@dashboard/`, `@coss/ui/`), or the whole key when no `*`. */
  readonly prefix: string;
  /** Whether the key had a trailing `*` (so it matches by prefix, not exactly). */
  readonly wildcard: boolean;
}

/** A repo's own-alias matcher, derived once per tsconfig directory. */
export interface OwnAliasMatcher {
  /** True iff `specifier` is reached through an alias that maps into own source. */
  readonly isOwnAlias: (specifier: string) => boolean;
}

const NEVER: OwnAliasMatcher = { isOwnAlias: () => false };

const matcherCache = new Map<string, OwnAliasMatcher>();

/** Find the nearest `tsconfig.json` at or above `dir`, or `null`. */
function findTsconfig(dir: string): string | null {
  return ts.findConfigFile(dir, ts.sys.fileExists, "tsconfig.json") ?? null;
}

/**
 * The effective `{ baseUrl, paths }` for a tsconfig, with its `extends` chain
 * already merged. We let TypeScript itself parse the file — it handles JSONC
 * (comments, trailing commas), resolves `extends` (including shared-config
 * packages under `node_modules`), and merges `paths`/`baseUrl` exactly as the
 * customer's build does. A hand-rolled JSON stripper would diverge from real TS
 * resolution; reusing the compiler API is the in-stack primitive. Returns
 * `null` when the file can't be read/parsed at all.
 */
interface EffectivePaths {
  /** Absolute dir the `paths` targets resolve against (baseUrl, else config dir). */
  readonly baseDir: string;
  /** The merged `paths` map (alias key -> target strings). */
  readonly paths: Readonly<Record<string, readonly string[]>>;
}

function readEffectivePaths(configPath: string): EffectivePaths | null {
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.config === undefined || read.config === null) return null;
  const configDir = dirname(configPath);
  // parseJsonConfigFileContent follows `extends` and merges compilerOptions.
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, configDir);
  const opts = parsed.options;
  // baseUrl is resolved to an absolute path by the parser; `paths` keys/targets
  // are relative to it (TS semantics). When no baseUrl is set TS still resolves
  // `paths` against the config dir, so fall back to that.
  const baseDir = typeof opts.baseUrl === "string" ? opts.baseUrl : configDir;
  const paths: Record<string, readonly string[]> = {};
  if (opts.paths !== undefined) {
    for (const [key, targets] of Object.entries(opts.paths)) {
      if (Array.isArray(targets)) {
        paths[key] = targets.filter((t): t is string => typeof t === "string");
      }
    }
  }
  return { baseDir, paths };
}

/**
 * Whether an alias TARGET points into the repo's own source. A relative path
 * (`src/*`, `../../packages/x/src/*`) is own source; a target that itself
 * begins with a bare package name or a `node_modules/` segment is a re-pointer
 * to an external dependency, not own code. The target is resolved against
 * `baseDir` and rejected if it climbs into a `node_modules` directory.
 */
function targetIsOwnSource(target: string, baseDir: string): boolean {
  // Strip the trailing `/*` (or `*`) wildcard for classification.
  const cleaned = target.replace(/\*+$/, "").replace(/\/$/, "");
  // A target that routes through node_modules is an external re-point.
  if (cleaned.includes("node_modules")) return false;
  const abs = resolve(baseDir, cleaned);
  return !`${abs}${sep}`.includes(`${sep}node_modules${sep}`);
}

/** Compile a `paths` key into its literal prefix + wildcard flag. */
function compileAliasKey(key: string): AliasPrefix {
  const star = key.indexOf("*");
  if (star === -1) return { prefix: key, wildcard: false };
  return { prefix: key.slice(0, star), wildcard: true };
}

/**
 * Build the own-alias matcher for the tsconfig governing `fromDir`. Cached per
 * directory so each repo's config is parsed once. Returns a matcher that always
 * answers `false` when there is no usable tsconfig — the caller then keeps its
 * pre-existing own-code heuristics.
 */
export function ownAliasMatcherFor(fromDir: string): OwnAliasMatcher {
  const cached = matcherCache.get(fromDir);
  if (cached !== undefined) return cached;

  const configPath = findTsconfig(fromDir);
  if (configPath === null) {
    matcherCache.set(fromDir, NEVER);
    return NEVER;
  }
  const effective = readEffectivePaths(configPath);
  if (effective === null) {
    matcherCache.set(fromDir, NEVER);
    return NEVER;
  }

  // Keep only the aliases whose target maps into own source — those are the
  // ones that must be excluded from design-system ranking.
  const ownPrefixes: AliasPrefix[] = [];
  for (const [key, targets] of Object.entries(effective.paths)) {
    if (targets.some((t) => targetIsOwnSource(t, effective.baseDir))) {
      ownPrefixes.push(compileAliasKey(key));
    }
  }

  const isOwnAlias = (specifier: string): boolean =>
    ownPrefixes.some((p) => (p.wildcard ? specifier.startsWith(p.prefix) : specifier === p.prefix));

  const matcher: OwnAliasMatcher = { isOwnAlias };
  matcherCache.set(fromDir, matcher);
  return matcher;
}

/** Reset the matcher cache — test-only, so fixtures don't bleed across cases. */
export function __resetAliasCacheForTest(): void {
  matcherCache.clear();
}
