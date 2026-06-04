/**
 * The bridge between a committed `binclusive.json` and a scan.
 *
 * `scan` is config-OPTIONAL: with no contract it behaves exactly as before.
 * This module is what makes it config-AWARE when a contract IS present — it
 * finds the nearest contract at or above the scanned files, and turns the
 * customer's escape-hatch declarations + enforcement policy into the small,
 * pure predicates `scan` applies:
 *
 *   - `ignore` globs   -> drop matching files before they are ever linted
 *   - `ignore` rule ids -> drop findings for a disabled rule ("off")
 *   - `enforcement`     -> tag each surviving finding `block` vs `warn`
 *
 * Everything here is a pure function of the contract + a path/rule id, so the
 * scan stays deterministic and the behavior is unit-testable without disk.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { type Contract, parseContract } from "./contract";

/** The committed contract file name — single source, shared with `commands.ts`. */
const CONTRACT_FILE = "binclusive.json";

/**
 * Walk UP from `dir` (inclusive) to the nearest ancestor holding a
 * `binclusive.json`, load + boundary-parse it, and return the contract — or
 * `null` when none is found (the zero-config case). A present-but-malformed
 * contract THROWS via `parseContract`: a broken committed config must surface,
 * not be silently ignored mid-scan.
 *
 * This is the package-up rule the rest of the toolchain uses: a scan pointed at
 * a nested `src/` still picks up the app's contract one or more levels above.
 */
export function findContractFrom(dir: string): Contract | null {
  let cur = dir;
  for (;;) {
    const path = join(cur, CONTRACT_FILE);
    if (existsSync(path)) {
      const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
      return parseContract(raw);
    }
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/**
 * Given a set of absolute file paths, find the contract that governs them by
 * walking up from their longest common directory. Returns `null` for an empty
 * set or when no contract exists at or above the files.
 */
export function contractForFiles(filePaths: readonly string[]): Contract | null {
  if (filePaths.length === 0) return null;
  return findContractFrom(commonBaseDir(filePaths));
}

/**
 * Longest common directory of the given absolute paths. Shared by the scan
 * (as ESLint's `cwd`, so targets fall inside the flat-config base path —
 * otherwise ESLint silently reports "outside of base path" and yields zero
 * findings) and by contract find-up (the dir to walk up from). Falls back to
 * `process.cwd()` for empty input; root `sep` when the paths share no prefix.
 */
export function commonBaseDir(paths: readonly string[]): string {
  if (paths.length === 0) return process.cwd();
  const segmentLists = paths.map((p) => dirname(p).split(sep));
  const first = segmentLists[0] ?? [];
  const common: string[] = [];
  for (let i = 0; i < first.length; i++) {
    const seg = first[i];
    if (segmentLists.every((segs) => segs[i] === seg)) common.push(seg);
    else break;
  }
  const joined = common.join(sep);
  return joined === "" ? sep : joined;
}

/**
 * Compile one `ignore` glob into a matcher. Supported, deliberately small, glob
 * vocabulary (these are file-skip patterns, not a full shell glob):
 *
 *   - `**` matches across path separators (any depth)
 *   - `*`  matches within a single path segment (no separator)
 *   - `?`  matches one non-separator character
 *
 * Anchored with `(^|/)…$`, so a no-`/` pattern matches the BASENAME at any
 * depth (`*.test.tsx` matches `a/b/x.test.tsx`) and a `/`-bearing pattern
 * matches a path suffix (`src/legacy/*`, `**​/generated/**`). Everything outside
 * the glob tokens is escaped, so `.` is literal — what you want for a filename.
 */
function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**` → any chars incl. separator. Swallow a trailing `/` so
        // `**/x` also matches `x` at the root, not just `dir/x`.
        out += "[^]*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        out += "[^/]*"; // single-segment wildcard
      }
    } else if (c === "?") {
      out += "[^/]";
    } else if (c !== undefined && /[.+^${}()|[\]\\]/.test(c)) {
      out += `\\${c}`;
    } else {
      out += c ?? "";
    }
  }
  return new RegExp(`(^|/)${out}$`);
}

/**
 * A reusable file-skip predicate built from the `ignore` globs. Patterns are
 * matched against the path with `/` separators (normalized from the OS sep) so
 * the same contract behaves identically on every platform. Rule-id entries in
 * `ignore` are NOT file globs — they are filtered out here (a rule id has no
 * path separator and is handled by {@link ignoredRuleIds}).
 */
export function fileIgnoreMatcher(ignore: readonly string[]): (filePath: string) => boolean {
  // A jsx-a11y rule id (e.g. `alt-text`, `jsx-a11y/alt-text`) is not a file
  // glob; only treat an entry as a glob if it looks like a path pattern.
  const globs = ignore.filter(isFileGlob).map(globToRegExp);
  if (globs.length === 0) return () => false;
  return (filePath: string): boolean => {
    const norm = filePath.split(sep).join("/");
    return globs.some((re) => re.test(norm));
  };
}

/**
 * Whether an `ignore` entry is a FILE GLOB rather than a rule id. A rule id is a
 * bare jsx-a11y name (optionally `jsx-a11y/`-prefixed) with no glob/path
 * punctuation; anything carrying `*`, `?`, `.`, or a path separator is a glob.
 * The two namespaces never collide because jsx-a11y ids are kebab-case words.
 */
function isFileGlob(entry: string): boolean {
  if (entry.startsWith("jsx-a11y/")) return false; // explicit rule id
  return /[*?./\\]/.test(entry);
}

/**
 * The set of jsx-a11y rule ids to drop, normalized to the full `jsx-a11y/<id>`
 * form so a finding's `ruleId` can be tested directly. Accepts both the bare
 * (`alt-text`) and prefixed (`jsx-a11y/alt-text`) spellings in the contract.
 */
export function ignoredRuleIds(ignore: readonly string[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (const entry of ignore) {
    if (isFileGlob(entry)) continue; // a path glob, not a rule id
    out.add(entry.startsWith("jsx-a11y/") ? entry : `jsx-a11y/${entry}`);
  }
  return out;
}

/** A finding's enforcement level, decided by the contract's policy. */
export type EnforcementLevel = "block" | "warn";

/**
 * Decide a finding's enforcement level from its WCAG SC against the contract.
 * A finding is `block` iff ANY of its SC is in `enforcement.block`; otherwise
 * `warn`. With no contract the level is `block` for everything — the historical
 * behavior where every finding gated the CLI exit code.
 */
export function enforcementFor(
  wcag: readonly string[],
  contract: Contract | null,
): EnforcementLevel {
  if (contract === null) return "block";
  const block = new Set(contract.enforcement.block);
  return wcag.some((sc) => block.has(sc)) ? "block" : "warn";
}
