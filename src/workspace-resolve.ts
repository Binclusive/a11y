import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";

/**
 * Workspace-package resolver: follow a `@scope/pkg[/subpath]` import to its
 * REAL source file by reading the monorepo's workspace config, not by trusting
 * an installed `node_modules` tree.
 *
 * Why this exists. A customer's app imports its design system as a published-
 * looking specifier (`@rallly/ui/button`), but in a monorepo that package lives
 * as source under `packages/ui` and is wired up by `pnpm-workspace.yaml` /
 * `package.json#workspaces`. TypeScript's own resolver only reaches it through
 * the symlink farm pnpm/yarn create under `node_modules` — which a freshly-
 * cloned, un-installed repo does not have. So the wrapper is reported OPAQUE
 * even though its source is sitting right there in the repo.
 *
 * This module resolves it the way the workspace itself defines it:
 *   1. Walk UP from the importing file to the workspace root (the dir holding
 *      `pnpm-workspace.yaml` or a `package.json` with a `workspaces` field).
 *   2. Expand the workspace package globs (`packages/*`, `apps/*`, ...) to the
 *      concrete package directories on disk.
 *   3. Match the import's package name against each candidate's
 *      `package.json#name`.
 *   4. Resolve the import's subpath against that package's `exports` map (incl.
 *      `"./*"` wildcards), falling back to `main` / `module` / `types` / an
 *      `index.{ts,tsx,js,jsx}` for a bare package import.
 *
 * Everything is best-effort and boundary-parsed: a malformed manifest, an
 * unmatched name, or a subpath the `exports` map doesn't cover all yield
 * `null` — the caller then treats the wrapper as opaque rather than guessing.
 */

/** File extensions we treat as resolvable source, in resolution-preference order. */
const SOURCE_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"] as const;

/** Conditional-export keys we read, in preference order (source over built). */
const EXPORT_CONDITIONS = ["source", "types", "import", "module", "default", "require"] as const;

/** A discovered workspace: its root dir and the package globs it declares. */
interface Workspace {
  readonly root: string;
  readonly globs: readonly string[];
}

const workspaceCache = new Map<string, Workspace | null>();

/**
 * Find the nearest workspace root at or above `fromDir`, with its package
 * globs. A `pnpm-workspace.yaml` wins; otherwise a `package.json` with a
 * `workspaces` array (npm/yarn/bun). Returns `null` when no workspace contains
 * the file. Cached per starting directory.
 */
function findWorkspace(fromDir: string): Workspace | null {
  const cached = workspaceCache.get(fromDir);
  if (cached !== undefined) return cached;

  let dir = fromDir;
  // Walk up to the filesystem root.
  for (;;) {
    const pnpm = join(dir, "pnpm-workspace.yaml");
    if (existsSync(pnpm)) {
      const globs = parsePnpmWorkspaceGlobs(readFileSafe(pnpm));
      const ws: Workspace = { root: dir, globs };
      workspaceCache.set(fromDir, ws);
      return ws;
    }
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      const globs = parsePackageJsonWorkspaceGlobs(readFileSafe(pkgPath));
      if (globs.length > 0) {
        const ws: Workspace = { root: dir, globs };
        workspaceCache.set(fromDir, ws);
        return ws;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  workspaceCache.set(fromDir, null);
  return null;
}

function readFileSafe(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/**
 * Extract the package globs from a `pnpm-workspace.yaml`. The `packages:` key
 * holds a YAML list of glob strings; we read just that list with a small
 * line scanner (no YAML dependency). Negated globs (`!...`) and the quote
 * styles pnpm permits are handled. Anything we can't parse yields no globs.
 */
function parsePnpmWorkspaceGlobs(yaml: string): string[] {
  const lines = yaml.split(/\r?\n/);
  const out: string[] = [];
  let inPackages = false;
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, "").trimEnd();
    if (/^packages\s*:/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      const item = /^\s*-\s*(.+)$/.exec(line);
      if (item?.[1] !== undefined) {
        out.push(stripYamlScalar(item[1]));
        continue;
      }
      // A non-list, non-blank, top-level key ends the packages block.
      if (line.trim() !== "" && !/^\s/.test(line)) inPackages = false;
    }
  }
  return out.filter((g) => g !== "" && !g.startsWith("!"));
}

/** Strip surrounding quotes from a YAML scalar value. */
function stripYamlScalar(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/** Read `workspaces` from a `package.json` (array form, or `{ packages: [] }`). */
function parsePackageJsonWorkspaceGlobs(text: string): string[] {
  const pkg = parseJson(text);
  if (pkg === null) return [];
  const ws = pkg.workspaces;
  if (Array.isArray(ws)) return ws.filter((g): g is string => typeof g === "string");
  if (typeof ws === "object" && ws !== null && !Array.isArray(ws)) {
    const packages = (ws as Record<string, unknown>).packages;
    if (Array.isArray(packages)) return packages.filter((g): g is string => typeof g === "string");
  }
  return [];
}

function parseJson(text: string): Record<string, unknown> | null {
  if (text === "") return null;
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Expand a workspace glob (`packages/*`, `apps/*`, or a literal `packages/ui`)
 * to the concrete package directories on disk. Only the single trailing `/*`
 * wildcard pnpm/yarn workspaces use in practice is supported; deeper globbing
 * is out of scope (and would over-reach). Each candidate must contain a
 * `package.json` to count.
 */
function expandGlob(root: string, glob: string): string[] {
  const normalized = glob.replace(/\\/g, "/").replace(/\/$/, "");
  if (normalized.endsWith("/*")) {
    const base = join(root, normalized.slice(0, -2));
    if (!isDir(base)) return [];
    const out: string[] = [];
    for (const name of readdirSafe(base)) {
      const dir = join(base, name);
      if (isDir(dir) && existsSync(join(dir, "package.json"))) out.push(dir);
    }
    return out;
  }
  // Literal package path.
  const dir = join(root, normalized);
  return isDir(dir) && existsSync(join(dir, "package.json")) ? [dir] : [];
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function readdirSafe(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

/** Per-workspace-root index of package-name -> package-dir, built once. */
const packageDirCache = new Map<string, ReadonlyMap<string, string>>();

function packageDirsFor(ws: Workspace): ReadonlyMap<string, string> {
  const cached = packageDirCache.get(ws.root);
  if (cached !== undefined) return cached;
  const byName = new Map<string, string>();
  for (const glob of ws.globs) {
    for (const dir of expandGlob(ws.root, glob)) {
      const pkg = parseJson(readFileSafe(join(dir, "package.json")));
      const name = pkg?.name;
      if (typeof name === "string" && !byName.has(name)) byName.set(name, dir);
    }
  }
  packageDirCache.set(ws.root, byName);
  return byName;
}

/**
 * Split a bare import specifier into its package name and the subpath after it.
 * `@rallly/ui/button` -> { pkg: "@rallly/ui", sub: "./button" };
 * `@rallly/ui`        -> { pkg: "@rallly/ui", sub: "." };
 * `lodash/fp`         -> { pkg: "lodash",     sub: "./fp" }.
 * Relative/aliased specifiers are not packages -> `null`.
 */
function splitSpecifier(specifier: string): { pkg: string; sub: string } | null {
  if (specifier === "" || specifier.startsWith(".") || isAbsolute(specifier)) return null;
  const parts = specifier.split("/");
  if (specifier.startsWith("@")) {
    if (parts.length < 2) return null;
    const pkg = `${parts[0]}/${parts[1]}`;
    const rest = parts.slice(2).join("/");
    return { pkg, sub: rest === "" ? "." : `./${rest}` };
  }
  const pkg = parts[0] ?? specifier;
  const rest = parts.slice(1).join("/");
  return { pkg, sub: rest === "" ? "." : `./${rest}` };
}

/**
 * Resolve an import specifier to a workspace package's real source file, or
 * `null` when it is not a workspace package (or its subpath can't be mapped).
 *
 * @param specifier the bare module specifier as written (`@rallly/ui/button`)
 * @param fromFile  the importing file, used to locate the workspace root
 */
export function resolveWorkspaceImport(specifier: string, fromFile: string): string | null {
  const split = splitSpecifier(specifier);
  if (split === null) return null;

  const ws = findWorkspace(dirname(fromFile));
  if (ws === null) return null;

  const pkgDir = packageDirsFor(ws).get(split.pkg);
  if (pkgDir === undefined) return null;

  const pkg = parseJson(readFileSafe(join(pkgDir, "package.json")));
  if (pkg === null) return null;

  return resolveSubpathInPackage(pkgDir, pkg, split.sub);
}

/**
 * Resolve a subpath (`.` or `./button`) against a package directory, honoring
 * its `exports` map first (including a `"./*"` wildcard), then the legacy
 * `main`/`module`/`types` fields for the package root, then an `index.*` file.
 */
function resolveSubpathInPackage(
  pkgDir: string,
  pkg: Record<string, unknown>,
  sub: string,
): string | null {
  const fromExports = resolveViaExports(pkgDir, pkg.exports, sub);
  if (fromExports !== null) return fromExports;

  // No `exports` (or it didn't cover this subpath). Legacy fields only define
  // the package root; a sub-path import without an `exports` map resolves as a
  // file/dir relative to the package directory.
  if (sub === ".") {
    for (const field of ["source", "module", "main", "types"] as const) {
      const target = pkg[field];
      if (typeof target === "string") {
        const hit = resolveFileTarget(join(pkgDir, target));
        if (hit !== null) return hit;
      }
    }
    return resolveFileTarget(join(pkgDir, "index"));
  }
  return resolveFileTarget(join(pkgDir, sub.slice(2)));
}

/**
 * Resolve a subpath against a package's `exports` field. Handles:
 *   - string exports: `{ ".": "./src/index.ts" }`
 *   - conditional exports: `{ ".": { "import": "./...", "types": "./..." } }`
 *   - subpath wildcards: `{ "./*": "./src/*.tsx" }` — the matched segment is
 *     substituted into the target's `*`.
 * Returns `null` when the subpath has no matching export entry.
 */
function resolveViaExports(pkgDir: string, exportsField: unknown, sub: string): string | null {
  if (typeof exportsField !== "object" || exportsField === null || Array.isArray(exportsField)) {
    // A string `exports` shorthand only defines the package root.
    if (typeof exportsField === "string" && sub === ".") {
      return resolveFileTarget(join(pkgDir, exportsField));
    }
    return null;
  }
  const map = exportsField as Record<string, unknown>;

  // Exact key first (`.`, `./button`).
  if (sub in map) {
    const target = pickConditionTarget(map[sub]);
    if (target !== null) return resolveFileTarget(join(pkgDir, target));
  }

  // Wildcard keys (`./*`, `./hooks/*`). Longest static prefix wins so a more
  // specific pattern (`./hooks/*`) beats the catch-all (`./*`).
  const wildcards = Object.keys(map)
    .filter((k) => k.includes("*"))
    .sort((a, b) => b.length - a.length);
  for (const key of wildcards) {
    const matched = matchWildcard(key, sub);
    if (matched === null) continue;
    const target = pickConditionTarget(map[key]);
    if (target === null) continue;
    const resolvedTarget = target.replace("*", matched);
    const hit = resolveFileTarget(join(pkgDir, resolvedTarget));
    if (hit !== null) return hit;
  }
  return null;
}

/**
 * Match `sub` against a `"./prefix/*suffix"` export key, returning the text the
 * `*` captured, or `null` when it doesn't match. Standard Node `exports`
 * semantics: exactly one `*` in the key.
 */
function matchWildcard(key: string, sub: string): string | null {
  const star = key.indexOf("*");
  if (star === -1) return null;
  const prefix = key.slice(0, star);
  const suffix = key.slice(star + 1);
  if (!sub.startsWith(prefix) || !sub.endsWith(suffix)) return null;
  if (sub.length < prefix.length + suffix.length) return null;
  return sub.slice(prefix.length, sub.length - suffix.length);
}

/**
 * Reduce an `exports` entry to a single target string. A plain string is the
 * target; a conditions object is probed in our preference order (source before
 * built artifacts). Nested condition objects recurse. Returns `null` when no
 * usable string target is found.
 */
function pickConditionTarget(entry: unknown): string | null {
  if (typeof entry === "string") return entry;
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
  const obj = entry as Record<string, unknown>;
  for (const cond of EXPORT_CONDITIONS) {
    if (cond in obj) {
      const nested = pickConditionTarget(obj[cond]);
      if (nested !== null) return nested;
    }
  }
  // Fall back to the first usable target in declaration order.
  for (const value of Object.values(obj)) {
    const nested = pickConditionTarget(value);
    if (nested !== null) return nested;
  }
  return null;
}

/**
 * Turn a target path into an existing source file: try it verbatim, then with
 * each known source extension, then as a directory `index.*`. This is what
 * lets a `main: "src/index.ts"` (verbatim) and a wildcard target like
 * `"./src/button"` (extension-appended) both land on a real file. Returns the
 * absolute path of the first hit, or `null`.
 */
function resolveFileTarget(target: string): string | null {
  const abs = resolve(target);
  if (isFile(abs)) return abs;
  for (const ext of SOURCE_EXTS) {
    if (isFile(abs + ext)) return abs + ext;
  }
  // `.tsx` for a wildcard like `./src/*.tsx` is handled verbatim above; here we
  // also cover a directory target resolving to its index.
  if (isDir(abs)) {
    for (const ext of SOURCE_EXTS) {
      const idx = join(abs, `index${ext}`);
      if (isFile(idx)) return idx;
    }
  }
  // A target that already carries an extension we didn't list but exists.
  const { ext } = parse(abs);
  if (ext !== "" && isFile(abs)) return abs;
  return null;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Reset all caches — test-only, so fixtures don't bleed across cases. */
export function __resetWorkspaceCachesForTest(): void {
  workspaceCache.clear();
  packageDirCache.clear();
}
