/**
 * run.ts — clone each SHA-pinned Android repo and scan it with the Android XML
 * layout collector IN-PROCESS, writing one stable result JSON per repo.
 *
 * The Android analog of `experiments/unity-matrix/run.ts`. We import
 * {@link scanAndroidXml} from `src/collect-android-xml` DIRECTLY — the Android
 * analysis is in-process (plain XML, no subprocess, no network beyond the clone),
 * so calling the function is both faster and more deterministic than shelling a
 * CLI. The clone-at-SHA / result-loop / diff skeleton is shared with every other
 * matrix gate — see `experiments/_matrix/harness.ts` (#247).
 *
 * The gated quantity is the FINDING stream: count, per-rule counts, and the full
 * sorted finding list, plus SECONDARY parse coverage (`filesScanned` /
 * `parseErrors`). Determinism is the whole point: every repo is frozen at its
 * manifest sha and the finding list is sorted before it is written, so the only
 * thing that can move a result is THIS checker's own code. Results land in
 * results/<owner>__<name>.json (gitignored — raw, reproducible from the pinned
 * manifest); the committed regression record is the distilled baseline.json.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scanAndroidXml } from "../../src/collect-android-xml.ts";
import { distillFindings, type ResultFinding, runManifest } from "../_matrix/harness.ts";

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

type AndroidScan = Omit<AndroidResult, "repo" | "sha" | "pinned" | "error">;

/** Scan one cloned Android repo and distill the in-process scan into a stable record. */
async function scanRepo(dir: string): Promise<AndroidScan> {
  const scan = await scanAndroidXml(dir);
  return {
    ...distillFindings(scan.findings, dir),
    filesScanned: scan.files.length,
    parseErrors: scan.parseErrors,
  };
}

export async function runAll(): Promise<void> {
  await runManifest<ManifestEntry, AndroidScan>({
    manifestPath: MANIFEST_PATH,
    manifestKey: "repos",
    cacheDir: CACHE_DIR,
    resultsDir: RESULTS_DIR,
    cloneTimeoutMs: CLONE_TIMEOUT_MS,
    errPad: 28,
    scan: scanRepo,
    zero: { findingsCount: 0, byRule: {}, findings: [], filesScanned: 0, parseErrors: 0 },
    logSuccess: (repo, scan) => {
      console.log(
        `${repo.padEnd(28)} findings=${String(scan.findingsCount).padStart(4)}  ` +
          `files=${String(scan.filesScanned).padStart(4)}  ` +
          `[${Object.entries(scan.byRule)
            .map(([k, v]) => `${k.replace("android-xml/", "")}=${v}`)
            .join(" ")}]`,
      );
    },
  });
}

if (import.meta.url === `file://${process.argv[1]}`) runAll();
