/**
 * run.ts — clone each pinned repo, COLD-scan it with the a11y-checker, and
 * write one result JSON per repo.
 *
 * Cold scan = no `init`, no `pnpm install`, no manual component declarations.
 * We are measuring OUT-OF-THE-BOX recall per stack, so we drive the checker
 * exactly as a first-time user would: `cli.ts check <srcDir> --json`.
 *
 * The checker EXITS NON-ZERO when it finds blocking issues — that is the
 * normal, expected path, NOT a failure. We parse stdout regardless of exit
 * code; only empty/unparseable stdout counts as a scan failure.
 *
 * Results land in results/<owner>__<name>.json and are .gitignored (raw, large,
 * reproducible from the pinned manifest).
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { detectFramework } from "./matrix.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, "..", "..");
const CLI = join(PLUGIN_ROOT, "src", "cli.ts");
const MANIFEST_PATH = join(HERE, "manifest.json");
const CACHE_DIR = join(HERE, ".cache");
const RESULTS_DIR = join(HERE, "results");

const SCAN_TIMEOUT_MS = 120_000;
const CLONE_TIMEOUT_MS = 120_000;

interface ManifestEntry {
  repo: string;
  designSystem: string;
  defaultBranch: string;
  sha: string;
  stars: number;
  source: string;
}

const slug = (repo: string) => repo.replace("/", "__");

/** Shallow-clone repo@branch into `dir`. Reuse if already present. */
function cloneRepo(repo: string, branch: string, dir: string): void {
  if (existsSync(join(dir, ".git"))) return; // reuse cache
  execFileSync(
    "git",
    [
      "clone",
      "--depth",
      "1",
      "--branch",
      branch,
      `https://github.com/${repo}.git`,
      dir,
    ],
    { stdio: "ignore", timeout: CLONE_TIMEOUT_MS },
  );
}

/** Record the actual HEAD sha of a clone. */
function headSha(dir: string): string {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "out",
  "coverage",
  ".cache",
  ".turbo",
]);

/**
 * Walk the clone and count *.tsx per directory subtree. Return the directory
 * whose subtree holds the most .tsx files — this handles monorepos (e.g.
 * phoenix → apps/web). If a `src/` exists directly under the winning package,
 * prefer it (tighter, fewer config-file false positives).
 */
function findTsxRoot(root: string): { dir: string; files: number } {
  // tsxCount[dir] = number of .tsx anywhere beneath dir (inclusive subtree).
  const subtree = new Map<string, number>();

  function walk(dir: string): number {
    let count = 0;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return 0;
    }
    for (const name of entries) {
      if (SKIP_DIRS.has(name)) continue;
      const full = join(dir, name);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        count += walk(full);
      } else if (name.endsWith(".tsx")) {
        count += 1;
      }
    }
    subtree.set(dir, count);
    return count;
  }
  walk(root);

  // Pick the deepest directory that still contains the global max — i.e. the
  // tightest subtree that captures essentially all the .tsx files. We approach
  // this by choosing the dir with the most files, breaking ties toward deeper
  // (more specific) paths.
  let best = root;
  let bestCount = 0;
  for (const [dir, count] of subtree) {
    if (count > bestCount || (count === bestCount && dir.length > best.length)) {
      best = dir;
      bestCount = count;
    }
  }

  // Tighten: if the chosen package has a conventional src/ holding most files,
  // use it. Walk down through single-child wrappers toward a `src`.
  const srcCandidate = join(best, "src");
  if (existsSync(srcCandidate) && (subtree.get(srcCandidate) ?? 0) >= bestCount * 0.6) {
    return { dir: srcCandidate, files: subtree.get(srcCandidate) ?? bestCount };
  }
  return { dir: best, files: bestCount };
}

/** Read package.json from the clone (root or nearest above tsxRoot). */
function readPkgJson(cloneRoot: string, tsxRoot: string): Record<string, unknown> {
  // Prefer the package.json nearest the tsxRoot (monorepo package), else root.
  let dir = tsxRoot;
  while (dir.startsWith(cloneRoot)) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) {
      try {
        return JSON.parse(readFileSync(pkg, "utf8"));
      } catch {
        break;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const rootPkg = join(cloneRoot, "package.json");
  if (existsSync(rootPkg)) {
    try {
      return JSON.parse(readFileSync(rootPkg, "utf8"));
    } catch {
      /* fall through */
    }
  }
  return {};
}

/**
 * Run the checker on `srcDir`. Returns parsed JSON. Throws if stdout is empty
 * or unparseable. Non-zero exit is NORMAL (blocking findings) — ignored.
 */
function runChecker(srcDir: string): unknown {
  const res = spawnSync("pnpm", ["exec", "tsx", CLI, "check", srcDir, "--json"], {
    cwd: PLUGIN_ROOT,
    encoding: "utf8",
    timeout: SCAN_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) throw new Error(`scan spawn error: ${res.error.message}`);
  if (res.signal) throw new Error(`scan timed out / killed (signal ${res.signal})`);
  const out = (res.stdout ?? "").trim();
  if (!out) throw new Error(`empty stdout (stderr: ${(res.stderr ?? "").slice(0, 200)})`);
  // The JSON object starts at the first "{"; tolerate any leading log noise.
  const start = out.indexOf("{");
  if (start < 0) throw new Error("no JSON object in stdout");
  return JSON.parse(out.slice(start));
}

function main() {
  mkdirSync(CACHE_DIR, { recursive: true });
  mkdirSync(RESULTS_DIR, { recursive: true });

  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as ManifestEntry[];

  for (const entry of manifest) {
    const { repo, designSystem, defaultBranch, sha, stars } = entry;
    const dir = join(CACHE_DIR, slug(repo));
    const resultPath = join(RESULTS_DIR, `${slug(repo)}.json`);

    try {
      cloneRepo(repo, defaultBranch, dir);
      const clonedSha = headSha(dir) || sha;

      const { dir: tsxRoot, files: tsxFiles } = findTsxRoot(dir);
      if (tsxFiles === 0) throw new Error("no .tsx files found in clone");

      const pkgJson = readPkgJson(dir, tsxRoot);
      const framework = detectFramework(pkgJson as never);

      const report = runChecker(tsxRoot) as {
        coverage: { checked: number; declare: number };
        summary: { findings: number; blocking: number };
      };

      const relTsxRoot = tsxRoot.slice(dir.length + 1) || ".";
      const result = {
        ...report,
        repo,
        designSystem,
        framework,
        sha: clonedSha,
        tsxRoot: relTsxRoot,
        stars,
        error: null as string | null,
      };
      writeFileSync(resultPath, JSON.stringify(result, null, 2) + "\n");

      console.log(
        `${repo.padEnd(34)} ${framework.padEnd(12)} ${designSystem.padEnd(10)} ` +
          `checked=${report.coverage.checked}/declare=${report.coverage.declare}  ` +
          `findings=${report.summary.findings}(${report.summary.blocking} blocking)`,
      );
    } catch (err) {
      const msg = (err as Error).message.split("\n")[0];
      writeFileSync(
        resultPath,
        JSON.stringify({ repo, designSystem, error: msg }, null, 2) + "\n",
      );
      console.log(`${repo.padEnd(34)} ERROR: ${msg}`);
    }
  }
}

main();
