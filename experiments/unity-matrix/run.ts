/**
 * run.ts — clone each SHA-pinned Unity repo and scan it with the Unity producer
 * IN-PROCESS, writing one stable result JSON per repo.
 *
 * This is the Unity analog of `experiments/shopify-matrix/run.ts` (which is in
 * turn the Liquid analog of the React `experiments/stack-matrix/run.ts`). We
 * import {@link scanUnity} from `src/collect-unity` DIRECTLY — the Unity static
 * analysis is in-process (no subprocess, no network beyond the clone), so calling
 * the function is both faster and more deterministic than shelling a CLI.
 *
 * The Unity producer emits NO findings yet — the structural-absence rules are
 * later children (#70/#72/#73). So the quantity we snapshot per repo is the
 * per-asset PARSE OUTCOME: how many assets parsed to a node graph, and how many
 * stayed OPAQUE (and why — binary vs parse-error). This is exactly the Force-Text
 * precision seam (ADR 0004): a binary (non-Force-Text) asset is reported opaque,
 * not silently skipped, and the count is committed so a regression that starts
 * silently dropping real UI assets is a visible diff.
 *
 * Determinism is the whole point: every repo is frozen at its manifest sha and
 * the asset list is sorted before it is written, so the only thing that can move
 * a result is THIS checker's own code. Results land in
 * results/<owner>__<name>.json (gitignored — raw, reproducible from the pinned
 * manifest); the committed regression record is the distilled baseline.json.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { scanUnity } from "../../src/collect-unity.ts";

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
  readonly uiSystem: string;
  readonly source: string;
  readonly caveat?: string;
}

/** The stable per-repo scan result written to results/<slug>.json.
 *
 * `graphCount` + `opaqueBinary` + `opaqueParseError` always sum to
 * `assetsScanned` — every asset lands in exactly one bucket, so a missing asset
 * (silent skip) would show up as a sum that no longer matches. */
export interface UnityResult {
  readonly repo: string;
  readonly sha: string;
  /** Whether the clone is parked at the manifest sha. false ⇒ a delta may be drift. */
  readonly pinned: boolean;
  /** uGUI prefab/scene YAML assets walked (.prefab + .unity). */
  readonly assetsScanned: number;
  /** Assets that parsed to a walkable node graph (Force-Text, parseable). */
  readonly graphCount: number;
  /** Assets reported OPAQUE because they are binary (non-Force-Text) — ADR 0004. */
  readonly opaqueBinary: number;
  /** Assets reported OPAQUE because Force-Text but unparseable. */
  readonly opaqueParseError: number;
  /** opaque / assets, rounded — the real-world under-scan (opaque) rate. */
  readonly opaqueRate: number;
  /** Every opaque asset, repo-relative + reason, sorted — so a newly-opaque (or
   * newly-parseable) asset is a line-level, reviewable diff, not just a count. */
  readonly opaqueAssets: readonly { file: string; reason: string }[];
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
 * Park a clone of `repo` at the EXACT pinned `sha` in `dir`. Mirrors the React /
 * Liquid harnesses: init + fetch-by-sha + checkout (GitHub serves a fetch of a
 * specific reachable sha). If fetch-by-sha is refused (e.g. GitHub will not serve
 * an unadvertised blob sha — the open-project-1 case, where the pinned sha is the
 * `main` HEAD), degrade to a shallow branch clone and record whatever HEAD we
 * actually got. The result's `sha`/`pinned` fields make drift visible rather than
 * silent: when the manifest sha IS the branch HEAD, the branch clone parks on it
 * exactly and `pinned` stays true.
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

const sortOpaque = (
  a: { file: string; reason: string },
  b: { file: string; reason: string },
): number => (a.file !== b.file ? (a.file < b.file ? -1 : 1) : a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0);

/** Scan one cloned Unity repo and distill the in-process scan into a stable record. */
async function scanRepo(dir: string): Promise<Omit<UnityResult, "repo" | "sha" | "pinned" | "error">> {
  const scan = await scanUnity(dir);

  let graphCount = 0;
  let opaqueBinary = 0;
  let opaqueParseError = 0;
  const opaqueAssets: { file: string; reason: string }[] = [];

  for (const asset of scan.assets) {
    if (asset.parse.kind === "graph") {
      graphCount++;
    } else {
      const reason = asset.parse.reason;
      if (reason === "binary") opaqueBinary++;
      else opaqueParseError++;
      opaqueAssets.push({ file: relative(dir, asset.file), reason });
    }
  }
  opaqueAssets.sort(sortOpaque);

  const assetsScanned = scan.assets.length;
  const opaqueTotal = opaqueBinary + opaqueParseError;

  return {
    assetsScanned,
    graphCount,
    opaqueBinary,
    opaqueParseError,
    opaqueRate: assetsScanned === 0 ? 0 : Math.round((opaqueTotal / assetsScanned) * 10000) / 10000,
    opaqueAssets,
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
      const result: UnityResult = {
        repo,
        sha: clonedSha,
        pinned: clonedSha === sha,
        error: null,
        ...scan,
      };
      writeFileSync(resultPath, JSON.stringify(result, null, 2) + "\n");

      console.log(
        `${repo.padEnd(34)} assets=${String(scan.assetsScanned).padStart(4)}  ` +
          `graph=${String(scan.graphCount).padStart(4)}  ` +
          `opaque=${String(scan.opaqueBinary + scan.opaqueParseError).padStart(3)} ` +
          `(bin=${scan.opaqueBinary} parse=${scan.opaqueParseError}, ${(scan.opaqueRate * 100).toFixed(1)}%)`,
      );
    } catch (err) {
      const msg = (err as Error).message.split("\n")[0];
      const result: UnityResult = {
        repo,
        sha,
        pinned: false,
        assetsScanned: 0,
        graphCount: 0,
        opaqueBinary: 0,
        opaqueParseError: 0,
        opaqueRate: 0,
        opaqueAssets: [],
        error: msg,
      };
      writeFileSync(resultPath, JSON.stringify(result, null, 2) + "\n");
      console.log(`${repo.padEnd(34)} ERROR: ${msg}`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) runAll();
