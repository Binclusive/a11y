/**
 * run.ts — clone each SHA-pinned Jetpack Compose repo and scan it with the Compose
 * engine OUT-OF-PROCESS, writing one stable result JSON per repo.
 *
 * This is the Compose analog of `experiments/unity-matrix/run.ts`. The one real
 * difference from unity is the scanner boundary: unity scans in-process, whereas
 * Compose runs the Kotlin PSI engine (`kotlin/A11yKotlinScan/`) as a subprocess.
 * We import {@link scanKotlin} from `src/collect-kotlin` — the thin TS boundary that
 * shells the Gradle-built engine, parses its JSON, and maps each raw record onto the
 * shared `Finding` shape (`provenance: "compose"`, ADR 0008). The engine must be
 * BUILT before this runs; see README.md for the `./gradlew installDist` step.
 *
 * What this gate snapshots (#118): the FINDING stream — `findingsCount`, per-rule
 * counts (`byRule`), and the full sorted finding list — exactly like unity-matrix's
 * primary layer. Compose has no secondary parse-outcome layer (the engine emits
 * findings only), so findings are the whole snapshot.
 *
 * Determinism is the whole point: every repo is frozen at its manifest sha and the
 * finding list is sorted by (file, line, ruleId) before it is written, so the only
 * thing that can move a result is THIS checker's own code — the Compose engine plus
 * its TS boundary. Results land in results/<owner>__<name>.json (gitignored — raw,
 * reproducible from the pinned manifest); the committed regression record is the
 * distilled baseline.json.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { scanKotlin } from "../../src/collect-kotlin.ts";

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
  readonly caveat?: string;
}

/** One scan finding, distilled to the stable, serializable triple we snapshot.
 * `file` is repo-relative so the record is independent of the clone path. */
export interface ResultFinding {
  readonly file: string;
  readonly line: number;
  readonly ruleId: string;
}

/** The stable per-repo scan result written to results/<slug>.json.
 *
 * The gated quantity is the finding stream (`findingsCount` / `byRule` /
 * `findings`); the Compose engine emits findings only, so there is no secondary
 * parse-outcome layer to snapshot alongside them. */
export interface ComposeResult {
  readonly repo: string;
  readonly sha: string;
  /** Whether the clone is parked at the manifest sha. false ⇒ a delta may be drift. */
  readonly pinned: boolean;
  /** Total findings the Compose engine emitted over the repo. */
  readonly findingsCount: number;
  /** ruleId -> count, so a diff can say "compose/image-no-label +3" not just "findings +3". */
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
 * Park a clone of `repo` at the EXACT pinned `sha` in `dir`. Mirrors the unity /
 * React / Liquid harnesses: init + fetch-by-sha + checkout (GitHub serves a fetch
 * of a specific reachable sha). If fetch-by-sha is refused (e.g. an unadvertised
 * blob sha), degrade to a shallow branch clone and record whatever HEAD we actually
 * got. The result's `sha`/`pinned` fields make drift visible rather than silent.
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

/** Scan one cloned Compose repo and distill the out-of-process scan into a stable record. */
async function scanRepo(dir: string): Promise<Omit<ComposeResult, "repo" | "sha" | "pinned" | "error">> {
  // The Compose engine emits paths under the canonical `root` it scanned, so
  // relative(root, …) yields the repo-relative path the snapshot commits.
  const scan = await scanKotlin(dir);
  const findings: ResultFinding[] = scan.findings
    .map((f) => ({ file: relative(scan.root, f.file), line: f.line, ruleId: f.ruleId }))
    .sort(sortFindings);

  const byRule: Record<string, number> = {};
  for (const f of findings) byRule[f.ruleId] = (byRule[f.ruleId] ?? 0) + 1;
  const sortedByRule: Record<string, number> = {};
  for (const id of Object.keys(byRule).sort()) sortedByRule[id] = byRule[id];

  return { findingsCount: findings.length, byRule: sortedByRule, findings };
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
      const result: ComposeResult = {
        repo,
        sha: clonedSha,
        pinned: clonedSha === sha,
        error: null,
        ...scan,
      };
      writeFileSync(resultPath, JSON.stringify(result, null, 2) + "\n");

      const ruleBits = Object.entries(scan.byRule)
        .map(([id, n]) => `${id} ${n}`)
        .join(", ");
      console.log(
        `${repo.padEnd(28)} findings=${String(scan.findingsCount).padStart(4)}` +
          (ruleBits !== "" ? `  [${ruleBits}]` : ""),
      );
    } catch (err) {
      const msg = (err as Error).message.split("\n")[0];
      const result: ComposeResult = {
        repo,
        sha,
        pinned: false,
        findingsCount: 0,
        byRule: {},
        findings: [],
        error: msg,
      };
      writeFileSync(resultPath, JSON.stringify(result, null, 2) + "\n");
      console.log(`${repo.padEnd(28)} ERROR: ${msg}`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) runAll();
