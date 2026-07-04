import fs from "node:fs";
import path from "node:path";
import { Project, type SourceFile } from "ts-morph";

/**
 * `parseDiagnostics` is the array the TS parser fills with SYNTACTIC errors as
 * it parses a file (populated for free at parse time). It is marked `@internal`
 * on `ts.SourceFile`, so it is absent from the public type — declare it here so
 * we can read it type-safely instead of casting. Optional + `readonly` mirrors
 * its real shape; `unknown` element type because we only ever count it.
 */
declare module "ts-morph" {
  namespace ts {
    interface SourceFile {
      readonly parseDiagnostics?: readonly unknown[];
    }
  }
}

/**
 * project.ts — the cheap pass loader (SPEC §3, §6-A3, §11).
 *
 * Loads a folder into a ts-morph Project with NO tsconfig: the type-checker is
 * never built, so this is fast and only syntactic getters are available. We add
 * source files via the A3 globs (include `.ts`/`.tsx`, exclude declarations,
 * vendored, build, and generated output), then detect parse failures per §11 —
 * a file is "failed" when ts-morph's syntactic diagnostics report a syntax
 * error, or when adding it threw. Failed files are excluded and surfaced, never
 * crash the run.
 */

/** A3 include/exclude globs. Globs are relative to the analyzed root. */
const INCLUDE_GLOBS = ["**/*.ts", "**/*.tsx"] as const;
const EXCLUDE_GLOBS = [
  "**/*.d.ts",
  "**/node_modules/**",
  "**/dist/**",
  "**/.next/**",
  "**/__generated__/**",
  "**/*.gen.ts",
] as const;

export type LoadedProject = {
  /** The ts-morph project (cheap pass — no type-checker built). */
  project: Project;
  /** The analyzed root, absolute. */
  rootAbsolute: string;
  /** Source files that parsed cleanly, in deterministic file order. */
  sourceFiles: SourceFile[];
  /** Analyzed-root-relative paths of files that failed to parse (§11), sorted. */
  parseFailures: string[];
};

/**
 * POSIX path relative to the ANALYZED ROOT (the folder passed to code-graph),
 * not the repo root. Join with `graph.root` to recover the absolute/repo path.
 */
export function toRelative(rootAbsolute: string, absolutePath: string): string {
  const rel = path.relative(rootAbsolute, absolutePath);
  return rel.split(path.sep).join("/");
}

/**
 * The TS parser records syntax errors on the SourceFile node as it parses —
 * `parseDiagnostics` is populated for free at parse time. It is marked
 * `@internal` on the public `ts.SourceFile` type, so we read it through this
 * narrow structural view (a `parseDiagnostics` array) instead of the
 * language service. A guard (`Array.isArray`) keeps it safe if the field is
 * ever absent. This is the same syntactic-error set the language service's
 * `getSyntacticDiagnostics` returns, without building a Program/language
 * service per file (which dominated cheap-pass time and timed out under CI
 * CPU contention — ~355ms of LS setup for ~30 files vs ~0ms here).
 */
/**
 * Does the source file have a syntactic (parse) error? §11: the TS parser is
 * error-tolerant and won't throw on bad syntax — it records the errors in the
 * node's own `parseDiagnostics`. We read those (SYNTACTIC only, NOT pre-emit /
 * semantic), which keeps the type-checker out of the cheap pass — semantic
 * errors here are just unresolved types from running without a tsconfig, not
 * parse failures. `Array.isArray` guards the case the field is ever absent.
 */
function hasSyntaxError(sourceFile: SourceFile): boolean {
  const diagnostics = sourceFile.compilerNode.parseDiagnostics;
  return Array.isArray(diagnostics) && diagnostics.length > 0;
}

/**
 * Load the folder under the cheap pass. `addSourceFilesAtPaths` with the A3
 * globs; a glob that resolves nothing yields an empty project (valid — §11
 * empty folder). Each file is probed for syntax errors; failures are collected
 * and excluded.
 */
export function loadCheapProject(rootAbsolute: string): LoadedProject {
  const project = new Project({
    // No tsConfigFilePath: the cheap pass never resolves modules or builds the
    // type-checker. In-memory file system is off — we read the real folder.
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    skipLoadingLibFiles: true,
    compilerOptions: { allowJs: false },
  });

  const globs = [
    ...INCLUDE_GLOBS.map((g) => path.join(rootAbsolute, g)),
    ...EXCLUDE_GLOBS.map((g) => `!${path.join(rootAbsolute, g)}`),
  ];

  const added = project.addSourceFilesAtPaths(globs);

  const clean: SourceFile[] = [];
  const failures: string[] = [];
  for (const sf of added) {
    const rel = toRelative(rootAbsolute, sf.getFilePath());
    // hasSyntaxError reads the parser's own diagnostics; a pathological file
    // could still throw — treat a throw as a parse failure (§11: never crash).
    let failed = false;
    try {
      failed = hasSyntaxError(sf);
    } catch {
      failed = true;
    }
    if (failed) {
      failures.push(rel);
      project.removeSourceFile(sf);
    } else {
      clean.push(sf);
    }
  }

  clean.sort((a, b) =>
    toRelative(rootAbsolute, a.getFilePath()).localeCompare(
      toRelative(rootAbsolute, b.getFilePath()),
    ),
  );
  failures.sort((a, b) => a.localeCompare(b));

  return { project, rootAbsolute, sourceFiles: clean, parseFailures: failures };
}

/**
 * The edge pass loads a SECOND, type-aware Project so module resolution works
 * (SPEC §3, §8). `scope: "package"` loads the analyzed folder's NEAREST
 * tsconfig (walk up from the path); `scope: "deep"` loads the monorepo ROOT
 * tsconfig (whole-repo cross-package callers). The returned project has the
 * type-checker available; functions must be re-enumerated against it (it is a
 * different Project instance than the cheap pass), and a fresh node→id map
 * rebuilt — never reuse the cheap pass's nodes.
 */
export type EdgeScope = "package" | "deep";

export type LoadedEdgeProject = LoadedProject & {
  /** Absolute path of the tsconfig the edge pass loaded (provenance, §5). */
  tsConfigPath: string;
  scope: EdgeScope;
};

/**
 * Walk up from `start` (a directory) to the filesystem root, returning the
 * first directory that contains a `tsconfig.json`, or null if none exists.
 */
function findNearestTsConfig(start: string): string | null {
  let dir = start;
  for (;;) {
    const candidate = path.join(dir, "tsconfig.json");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null; // hit FS root
    dir = parent;
  }
}

/**
 * Resolve the tsconfig for the edge pass. `package` → nearest tsconfig above the
 * analyzed root; `deep` → the monorepo root tsconfig (the nearest tsconfig above
 * `repoRoot`, which is `repoRoot/tsconfig.json` when present). Throws a clear
 * error when no tsconfig is found (the edge pass cannot resolve modules
 * without one — SPEC §3 requires tsconfig-backed loading).
 */
export function resolveEdgeTsConfig(
  rootAbsolute: string,
  scope: EdgeScope,
  repoRoot: string,
): string {
  const start = scope === "deep" ? repoRoot : rootAbsolute;
  const found = findNearestTsConfig(start);
  if (!found) {
    throw new Error(
      `code-graph: no tsconfig.json found ${scope === "deep" ? `at or above the repo root (${repoRoot})` : `at or above ${rootAbsolute}`}; the edge pass needs one to resolve modules (SPEC §3).`,
    );
  }
  return found;
}

/**
 * Is an analyzed-root-relative path one the A3 globs exclude (vendored, build, generated)?
 * Applied to in-project files the tsconfig pulled in, mirroring EXCLUDE_GLOBS.
 */
function isExcludedEdgeFile(rel: string): boolean {
  return (
    rel.includes("node_modules/") ||
    rel.includes("/dist/") ||
    rel.startsWith("dist/") ||
    rel.includes("/.next/") ||
    rel.includes("__generated__/") ||
    /\.gen\.ts$/.test(rel)
  );
}

/** Is this source file an A3-relevant node source UNDER the analyzed root? */
function isEnumerableEdgeFile(sf: SourceFile, rootAbsolute: string, rootPosix: string): boolean {
  const abs = sf.getFilePath();
  if (!abs.split(path.sep).join("/").startsWith(rootPosix)) return false;
  if (/\.d\.ts$/.test(abs)) return false;
  return !isExcludedEdgeFile(toRelative(rootAbsolute, abs));
}

/**
 * Split the project's source files into the A3-relevant ones UNDER the analyzed
 * root that parsed cleanly (§11) vs the parse failures. Other in-project files
 * (deps, siblings) stay loaded so the type-checker can resolve callees, but are
 * not enumerated as node sources.
 */
function collectEdgeSourceFiles(
  project: Project,
  rootAbsolute: string,
): { clean: SourceFile[]; failures: string[] } {
  const rootPosix = `${rootAbsolute.split(path.sep).join("/")}/`;
  const clean: SourceFile[] = [];
  const failures: string[] = [];
  for (const sf of project.getSourceFiles()) {
    if (!isEnumerableEdgeFile(sf, rootAbsolute, rootPosix)) continue;
    const rel = toRelative(rootAbsolute, sf.getFilePath());
    // hasSyntaxError reads the parser's own diagnostics; a pathological file
    // could still throw — treat a throw as a parse failure (§11: never crash).
    let failed = false;
    try {
      failed = hasSyntaxError(sf);
    } catch {
      failed = true;
    }
    if (failed) failures.push(rel);
    else clean.push(sf);
  }

  clean.sort((a, b) =>
    toRelative(rootAbsolute, a.getFilePath()).localeCompare(
      toRelative(rootAbsolute, b.getFilePath()),
    ),
  );
  failures.sort((a, b) => a.localeCompare(b));
  return { clean, failures };
}

/**
 * Load the type-aware edge-pass project (SPEC §3, §8). The tsconfig drives
 * module resolution and the type-checker; we then narrow to the A3-relevant
 * source files UNDER the analyzed root (the tsconfig may pull in the whole
 * package/monorepo, but functions/edges are still scoped to the analyzed
 * folder's files). Parse failures are detected per §11, identically to the
 * cheap pass.
 */
export function loadEdgeProject(
  rootAbsolute: string,
  scope: EdgeScope,
  repoRoot: string,
): LoadedEdgeProject {
  const tsConfigPath = resolveEdgeTsConfig(rootAbsolute, scope, repoRoot);

  const project = new Project({
    tsConfigFilePath: tsConfigPath,
    // Let the tsconfig's `include` drive which files load; we add the analyzed
    // root's A3 files explicitly below so nothing is missed even if the
    // tsconfig narrows includes. Lib files are needed for type resolution.
    skipAddingFilesFromTsConfig: false,
  });

  // Ensure every A3 file under the analyzed root is present (the tsconfig may
  // not include all of them). addSourceFilesAtPaths is idempotent on paths
  // already loaded from the tsconfig.
  const globs = [
    ...INCLUDE_GLOBS.map((g) => path.join(rootAbsolute, g)),
    ...EXCLUDE_GLOBS.map((g) => `!${path.join(rootAbsolute, g)}`),
  ];
  project.addSourceFilesAtPaths(globs);

  const { clean, failures } = collectEdgeSourceFiles(project, rootAbsolute);

  return {
    project,
    rootAbsolute,
    sourceFiles: clean,
    parseFailures: failures,
    tsConfigPath,
    scope,
  };
}
