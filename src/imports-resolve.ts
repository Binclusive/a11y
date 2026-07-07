import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";

/**
 * package.json `imports`-subpath resolver: follow a `#`-prefixed internal import
 * (`#app/components/ui/button`) to its REAL source file by reading the nearest
 * package.json's `imports` map, the same way Node + bundlers do.
 *
 * Why this exists. The checker already resolves tsconfig `paths` aliases and
 * workspace packages to own-code so it can TRACE them. Node's `imports` field is
 * the third own-code alias source — the `#`-prefixed internal subpath imports
 * Epic Stack and modern Remix-style repos use (`"#app/*": "./app/*"`). A bare
 * `import { Button } from "#app/components/ui/button"` (no extension) is invisible
 * to TypeScript's module resolution, so the own-code component it points at falls
 * into the opaque/declare set and hollows the `checked` count. (TS DOES follow a
 * `#`-import that carries an explicit extension — `#app/.../icon.tsx` — but not
 * the extensionless form, which is the common one.) This module fills that gap.
 *
 * It is ONE MORE ALIAS SOURCE, not a new subsystem — it mirrors
 * `resolveWorkspaceImport`'s shape (find root → match pattern → resolve target to
 * a file on disk) so a `#`-resolved target feeds the SAME trace/own-code
 * machinery as a tsconfig-`paths` target.
 *
 * Everything is best-effort + boundary-parsed: a missing/malformed package.json,
 * an `imports` value in an unrecognized shape, or a subpath no pattern covers all
 * yield `null` — the caller then keeps the wrapper opaque rather than guessing.
 */

/** File extensions we treat as resolvable source, in resolution-preference order. */
const SOURCE_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"] as const;

/**
 * Conditional-`imports` keys we read to pick the RUNTIME target, in preference
 * order. `default` first (the unconditional fallback Node always honors), then
 * the runtime conditions; `types` is deliberately absent — a `.d.ts` is not the
 * source we trace. Probed in this order so the actual code path wins.
 */
const IMPORT_CONDITIONS = ["default", "import", "require", "node", "browser"] as const;

/** A compiled `imports` entry: a `#`-prefixed subpath pattern and its target. */
interface ImportPattern {
  /** The key as written (`"#app/*"`, `"#config"`). */
  readonly key: string;
  /** The resolved runtime target string (`"./app/*"`), already condition-picked. */
  readonly target: string;
}

/** A discovered `imports` map: the dir its targets resolve against + the patterns. */
interface ImportsMap {
  readonly baseDir: string;
  readonly patterns: readonly ImportPattern[];
}

const importsCache = new Map<string, ImportsMap | null>();

/**
 * Find the nearest package.json at or above `fromDir` that declares an `imports`
 * field, returning its compiled patterns + base dir. Walks UP to the filesystem
 * root (the same root-detection the checker uses for stack/tsconfig), so a scan
 * pointed at a nested route file still finds the app's package.json. A
 * package.json WITHOUT `imports` does not stop the walk — a parent may carry it.
 * Cached per starting directory. Returns `null` when none is found.
 */
function findImportsMap(fromDir: string): ImportsMap | null {
  const cached = importsCache.get(fromDir);
  if (cached !== undefined) return cached;

  let dir = fromDir;
  for (;;) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      const patterns = parseImportsField(readFileSafe(pkgPath));
      if (patterns.length > 0) {
        const map: ImportsMap = { baseDir: dir, patterns };
        importsCache.set(fromDir, map);
        return map;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  importsCache.set(fromDir, null);
  return null;
}

function readFileSafe(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
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
 * Compile the `imports` field of a package.json into its `#`-prefixed patterns.
 * Each value is reduced to a single runtime target string: a plain string is the
 * target verbatim; a conditional object (`{ types, import, default }`) is probed
 * in {@link IMPORT_CONDITIONS} order (runtime target, never `types`). A value in
 * an unrecognized shape (array, no usable condition) is skipped — it never
 * crashes the parse. Only `#`-prefixed keys are kept (the `imports` spec requires
 * the `#` prefix; anything else is malformed and ignored).
 */
function parseImportsField(text: string): ImportPattern[] {
  const pkg = parseJson(text);
  if (pkg === null) return [];
  const imports = pkg.imports;
  if (typeof imports !== "object" || imports === null || Array.isArray(imports)) return [];
  const out: ImportPattern[] = [];
  for (const [key, value] of Object.entries(imports)) {
    if (!key.startsWith("#")) continue;
    const target = pickConditionTarget(value);
    if (target !== null) out.push({ key, target });
  }
  return out;
}

/**
 * Reduce an `imports` entry to a single RUNTIME target string. A plain string is
 * the target; a conditions object is probed in our preference order (`default`
 * first, then runtime conditions; `types` ignored). Nested condition objects
 * recurse. Returns `null` when no usable string target is found — the caller
 * skips that pattern gracefully.
 */
function pickConditionTarget(entry: unknown): string | null {
  if (typeof entry === "string") return entry;
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
  const obj = entry as Record<string, unknown>;
  for (const cond of IMPORT_CONDITIONS) {
    if (cond in obj) {
      const nested = pickConditionTarget(obj[cond]);
      if (nested !== null) return nested;
    }
  }
  // Fall back to the first usable target in declaration order, but never a
  // `types`-only entry (a `.d.ts` is not the source we want to trace).
  for (const [cond, value] of Object.entries(obj)) {
    if (cond === "types") continue;
    const nested = pickConditionTarget(value);
    if (nested !== null) return nested;
  }
  return null;
}

/**
 * Match a `#`-prefixed specifier against a pattern and substitute the `*`. Two
 * shapes, same as Node + tsconfig path globs:
 *   - wildcard `"#app/*"` -> `"./app/*"`: capture the text after the prefix and
 *     substitute it into the target's `*`.
 *   - exact `"#config"` -> `"./config.ts"`: the specifier must equal the key.
 * Returns the target with the wildcard filled, or `null` when no match.
 */
function applyPattern(pattern: ImportPattern, specifier: string): string | null {
  const star = pattern.key.indexOf("*");
  if (star === -1) {
    return specifier === pattern.key ? pattern.target : null;
  }
  const prefix = pattern.key.slice(0, star);
  const suffix = pattern.key.slice(star + 1);
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return null;
  if (specifier.length < prefix.length + suffix.length) return null;
  const matched = specifier.slice(prefix.length, specifier.length - suffix.length);
  return pattern.target.replace("*", matched);
}

/**
 * Resolve a `#`-prefixed import specifier to its own-code source file via the
 * nearest package.json `imports` map, or `null` when it is not an `imports`
 * subpath (or its target can't be mapped to a file). Longest-key-first so a more
 * specific pattern wins over a catch-all.
 *
 * @param specifier the bare module specifier as written (`#app/components/button`)
 * @param fromFile  the importing file, used to locate the package.json
 */
export function resolveImportsSubpath(specifier: string, fromFile: string): string | null {
  if (!specifier.startsWith("#")) return null;

  const map = findImportsMap(dirname(fromFile));
  if (map === null) return null;

  // Longest static prefix first: `#app/ui/*` beats `#app/*`.
  const ordered = [...map.patterns].sort((a, b) => b.key.length - a.key.length);
  for (const pattern of ordered) {
    const target = applyPattern(pattern, specifier);
    if (target === null) continue;
    const hit = resolveFileTarget(join(map.baseDir, target));
    if (hit !== null) return hit;
  }
  return null;
}

/**
 * Turn a target path into an existing source file: try it verbatim, then with
 * each known source extension, then as a directory `index.*`. This is what lets
 * an extensionless `#app/components/button` (extension-appended) and a target
 * that already carries an extension both land on a real file. Returns the
 * absolute path of the first hit, or `null`.
 */
function resolveFileTarget(target: string): string | null {
  const abs = resolve(target);
  if (isFile(abs)) return abs;
  for (const ext of SOURCE_EXTS) {
    if (isFile(abs + ext)) return abs + ext;
  }
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

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Reset the cache — test-only, so fixtures don't bleed across cases. */
export function __resetImportsCacheForTest(): void {
  importsCache.clear();
}
