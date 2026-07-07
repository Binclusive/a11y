/**
 * run.ts — clone each SHA-pinned Android repo and scan it with the Android XML
 * layout collector IN-PROCESS, writing one stable result JSON per repo.
 *
 * The Android analog of `experiments/unity-matrix/run.ts`. We import
 * {@link scanAndroidXml} from `src/collect-android-xml` DIRECTLY — the Android
 * analysis is in-process (plain XML, no subprocess, no network beyond the clone),
 * so calling the function is both faster and more deterministic than shelling a
 * CLI.
 *
 * The gated quantity is the FINDING stream: count, per-rule counts, and the full
 * sorted finding list (file:line:ruleId) — mirroring `unity-matrix`. Determinism
 * is the whole point: every repo is frozen at its manifest sha and the finding
 * list is sorted before it is written, so the only thing that can move a result
 * is THIS checker's own code. Results land in results/<owner>__<name>.json
 * (gitignored — raw, reproducible from the pinned manifest); the committed
 * regression record is the distilled baseline.json.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { scanAndroidXml } from "../../src/collect-android-xml.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(HERE, "manifest.json");
const CACHE_DIR = join(HERE, ".cache");
const RESULTS_DIR = join(HERE, "results");

const CLONE_TIMEOUT_MS = 600_000;

export interface ManifestEntry {
  readonly repo: string;
  readonly ref: string;
  readonly sha: string;
  readonly defaultBranch: string;
  readonly stars: number;
  readonly source: string;
}

/** One scan finding, distilled to the stable, serializable triple we snapshot.
 * `file` is repo-relative so the record is independent of the clone path. */
export interface ResultFinding {
  readonly file: string;
  readonly line: number;
  readonly ruleId: string;
}

/** The stable per-repo scan result written to results/<slug>.json. */
export interface AndroidResult {
  readonly repo: string;
  readonly sha: string;
  /** Whether the clone is parked at the manifest sha. false ⇒ a delta may be drift. */
  readonly pinned: boolean;
  /** Total findings the collector emitted over the repo. */
  readonly findingsCount: number;
  /** ruleId -> count, so a diff can say "android-xml/image-no-label +3", not just "findings +3". */
  readonly byRule: Record<string, number>;
  /** Every finding, sorted by (file, line, ruleId) for a stable, reviewable diff. */
  readonly findings: readonly ResultFinding[];
  /** res/layout* xml files walked. */
  readonly filesScanned: number;
  /** Files that could not be read (counted, not fatal). */
  readonly parseErrors: number;
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
 * Park a clone of `repo` at the EXACT pinned `sha` in `dir`. Mirrors the other
 * harnesses: init + fetch-by-sha + checkout (GitHub serves a fetch of a specific
 * reachable sha). If fetch-by-sha is refused, degrade to a shallow branch clone
 * and record whatever HEAD we actually got — the result's `sha`/`pinned` fields
 * make drift visible rather than silent.
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
  a.file !== b.file
    ? a.file < b.file
      ? -1
      : 1
    : a.line !== b.line
      ? a.line - b.line
      : a.ruleId < b.ruleId
        ? -1
        : a.ruleId > b.ruleId
          ? 1
          : 0;

/** Scan one cloned Android repo and distill the in-process scan into a stable record. */
async function scanRepo(dir: string): Promise<Omit<AndroidResult, "repo" | "sha" | "pinned" | "error">> {
  const scan = await scanAndroidXml(dir);
  const findings: ResultFinding[] = scan.findings
    .map((f) => ({ file: relative(dir, f.file), line: f.line, ruleId: f.ruleId }))
    .sort(sortFindings);

  const byRule: Record<string, number> = {};
  for (const f of findings) byRule[f.ruleId] = (byRule[f.ruleId] ?? 0) + 1;
  const sortedByRule: Record<string, number> = {};
  for (const id of Object.keys(byRule).sort()) sortedByRule[id] = byRule[id] as number;

  return {
    findingsCount: findings.length,
    byRule: sortedByRule,
    findings,
    filesScanned: scan.files.length,
    parseErrors: scan.parseErrors,
  };
}

export async function runAll(): Promise<void> {
  if (!existsSync(MANIFEST_PATH)) throw new Error(`No manifest at ${MANIFEST_PATH}`);
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")).repos as ManifestEntry[];

  mkdirSync(CACHE_DIR, { recursive: true });
  mkdirSync(RESULTS_DIR, { recursive: true });

  for (const entry of manifest) {
    const { repo, sha, defaultBranch } = entry;
    const dir = join(CACHE_DIR, slug(repo));
    const resultPath = join(RESULTS_DIR, `${slug(repo)}.json`);

    try {
      ensureRepoAt(repo, sha, defaultBranch, dir);
      const clonedSha = headSha(dir) || sha;

      const scan = await scanRepo(dir);
      const result: AndroidResult = {
        repo,
        sha: clonedSha,
        pinned: clonedSha === sha,
        error: null,
        ...scan,
      };
      writeFileSync(resultPath, JSON.stringify(result, null, 2) + "\n");

      console.log(
        `${repo.padEnd(28)} findings=${String(scan.findingsCount).padStart(4)}  ` +
          `files=${String(scan.filesScanned).padStart(4)}  ` +
          `[${Object.entries(scan.byRule)
            .map(([k, v]) => `${k.replace("android-xml/", "")}=${v}`)
            .join(" ")}]`,
      );
    } catch (err) {
      const msg = (err as Error).message.split("\n")[0];
      const result: AndroidResult = {
        repo,
        sha,
        pinned: false,
        findingsCount: 0,
        byRule: {},
        findings: [],
        filesScanned: 0,
        parseErrors: 0,
        error: msg,
      };
      writeFileSync(resultPath, JSON.stringify(result, null, 2) + "\n");
      console.log(`${repo.padEnd(28)} ERROR: ${msg}`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) runAll();
