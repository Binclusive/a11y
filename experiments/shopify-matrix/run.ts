/**
 * run.ts — clone each SHA-pinned Shopify theme and scan it with the Liquid
 * checker IN-PROCESS, writing one stable result JSON per theme.
 *
 * This is the Liquid analog of `experiments/stack-matrix/run.ts`. The React
 * harness shells `cli.ts check ... --json` per repo; here we import
 * {@link scanLiquid} from `src/collect-liquid` DIRECTLY — the Liquid analysis is
 * in-process (no subprocess, no network), so calling the function is both faster
 * and more deterministic than shelling the CLI.
 *
 * Determinism is the whole point: every theme is frozen at its manifest sha and
 * every list (findings, files) is sorted before it is written, so the only thing
 * that can move a result is THIS checker's own code. Results land in
 * results/<owner>__<name>.json (gitignored — raw, reproducible from the pinned
 * manifest); the committed regression record is the distilled baseline.json.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { scanLiquid } from "../../src/collect-liquid.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(HERE, "manifest.json");
const CACHE_DIR = join(HERE, ".cache");
const RESULTS_DIR = join(HERE, "results");

const CLONE_TIMEOUT_MS = 180_000;

export interface ManifestEntry {
  readonly repo: string;
  readonly ref: string;
  readonly sha: string;
  readonly defaultBranch: string;
  readonly stars: number;
  readonly source: string;
}

/** One scan finding, distilled to the stable, serializable triple we snapshot.
 * `file` is theme-relative so the record is independent of the clone path. */
export interface ResultFinding {
  readonly file: string;
  readonly line: number;
  readonly ruleId: string;
}

/** The stable per-theme scan result written to results/<slug>.json. */
export interface ThemeResult {
  readonly repo: string;
  readonly sha: string;
  /** Whether the clone is parked at the manifest sha. false ⇒ a delta may be drift. */
  readonly pinned: boolean;
  readonly filesScanned: number;
  readonly findingsCount: number;
  readonly parseErrorCount: number;
  /** parseErrors / filesScanned, rounded — the real-world under-scan rate (issue #51 signal). */
  readonly parseErrorRate: number;
  /** ruleId -> count, so a diff can say "liquid/img-alt +3" not just "findings +3". */
  readonly byRule: Record<string, number>;
  /** Every finding, sorted by (file, line, ruleId) for a stable, reviewable diff. */
  readonly findings: readonly ResultFinding[];
  readonly error: string | null;
}

const slug = (repo: string) => repo.replace("/", "__");

const git = (args: string[]) =>
  execFileSync("git", args, { stdio: "ignore", timeout: CLONE_TIMEOUT_MS });

/** Record the actual HEAD sha of a clone. */
function headSha(dir: string): string {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

/**
 * Park a clone of `repo` at the EXACT pinned `sha` in `dir`. Mirrors the React
 * harness: init + fetch-by-sha + checkout (GitHub serves a fetch of a specific
 * reachable sha). If fetch-by-sha is refused (sha force-pushed away), degrade to
 * a shallow branch clone and record whatever HEAD we actually got — the result's
 * `sha`/`pinned` fields make drift visible rather than silent.
 */
function ensureRepoAt(repo: string, sha: string, branch: string, dir: string): void {
  const url = `https://github.com/${repo}.git`;

  if (existsSync(join(dir, ".git"))) {
    if (headSha(dir) === sha) return; // cache already pinned
    try {
      git(["-C", dir, "fetch", "-q", "--depth", "1", "origin", sha]);
      git(["-C", dir, "checkout", "-q", sha]);
    } catch {
      /* keep cached HEAD; result records the actual sha */
    }
    return;
  }

  try {
    mkdirSync(dir, { recursive: true });
    git(["-C", dir, "init", "-q"]);
    git(["-C", dir, "remote", "add", "origin", url]);
    git(["-C", dir, "fetch", "-q", "--depth", "1", "origin", sha]);
    git(["-C", dir, "checkout", "-q", sha]);
  } catch {
    rmSync(dir, { recursive: true, force: true });
    git(["clone", "--depth", "1", "--branch", branch, url, dir]);
  }
}

const sortFindings = (a: ResultFinding, b: ResultFinding): number =>
  a.file !== b.file ? (a.file < b.file ? -1 : 1) : a.line !== b.line ? a.line - b.line : a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0;

/** Scan one cloned theme and distill the in-process scan into a stable record. */
async function scanTheme(dir: string): Promise<Omit<ThemeResult, "repo" | "sha" | "pinned" | "error">> {
  const scan = await scanLiquid(dir);

  const findings: ResultFinding[] = scan.findings
    .map((f) => ({ file: relative(dir, f.file), line: f.line, ruleId: f.ruleId }))
    .sort(sortFindings);

  const byRule: Record<string, number> = {};
  for (const f of findings) byRule[f.ruleId] = (byRule[f.ruleId] ?? 0) + 1;
  const sortedByRule: Record<string, number> = {};
  for (const id of Object.keys(byRule).sort()) sortedByRule[id] = byRule[id];

  const filesScanned = scan.files.length;
  const parseErrorCount = scan.parseErrors.length;

  return {
    filesScanned,
    findingsCount: findings.length,
    parseErrorCount,
    parseErrorRate: filesScanned === 0 ? 0 : Math.round((parseErrorCount / filesScanned) * 10000) / 10000,
    byRule: sortedByRule,
    findings,
  };
}

export async function runAll(): Promise<void> {
  if (!existsSync(MANIFEST_PATH)) throw new Error(`No manifest at ${MANIFEST_PATH}`);
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")).themes as ManifestEntry[];

  mkdirSync(CACHE_DIR, { recursive: true });
  mkdirSync(RESULTS_DIR, { recursive: true });

  for (const entry of manifest) {
    const { repo, sha, defaultBranch } = entry;
    const dir = join(CACHE_DIR, slug(repo));
    const resultPath = join(RESULTS_DIR, `${slug(repo)}.json`);

    try {
      ensureRepoAt(repo, sha, defaultBranch, dir);
      const clonedSha = headSha(dir) || sha;

      const scan = await scanTheme(dir);
      const result: ThemeResult = {
        repo,
        sha: clonedSha,
        pinned: clonedSha === sha,
        error: null,
        ...scan,
      };
      writeFileSync(resultPath, JSON.stringify(result, null, 2) + "\n");

      console.log(
        `${repo.padEnd(20)} files=${String(scan.filesScanned).padStart(4)}  ` +
          `findings=${String(scan.findingsCount).padStart(4)}  ` +
          `parseErrors=${String(scan.parseErrorCount).padStart(4)} ` +
          `(${(scan.parseErrorRate * 100).toFixed(1)}% of files skipped)`,
      );
    } catch (err) {
      const msg = (err as Error).message.split("\n")[0];
      const result: ThemeResult = {
        repo,
        sha,
        pinned: false,
        filesScanned: 0,
        findingsCount: 0,
        parseErrorCount: 0,
        parseErrorRate: 0,
        byRule: {},
        findings: [],
        error: msg,
      };
      writeFileSync(resultPath, JSON.stringify(result, null, 2) + "\n");
      console.log(`${repo.padEnd(20)} ERROR: ${msg}`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) runAll();
