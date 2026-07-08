/**
 * run.ts — clone each SHA-pinned Shopify theme and scan it with the Liquid
 * checker IN-PROCESS, writing one stable result JSON per theme.
 *
 * This is the Liquid analog of `experiments/stack-matrix/run.ts`. We import
 * {@link scanLiquid} from `src/collect-liquid` DIRECTLY — the Liquid analysis is
 * in-process (no subprocess, no network), so calling the function is both faster
 * and more deterministic than shelling the CLI. The clone-at-SHA / result-loop
 * skeleton is shared with every matrix gate (`experiments/_matrix/harness.ts`, #247).
 *
 * Determinism is the whole point: every theme is frozen at its manifest sha and
 * every list (findings, files) is sorted before it is written, so the only thing
 * that can move a result is THIS checker's own code. Results land in
 * results/<owner>__<name>.json (gitignored — raw, reproducible from the pinned
 * manifest); the committed regression record is the distilled baseline.json.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scanLiquid } from "../../src/collect-liquid.ts";
import { distillFindings, type ResultFinding, runManifest } from "../_matrix/harness.ts";

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

type ThemeScan = Omit<ThemeResult, "repo" | "sha" | "pinned" | "error">;

/** Scan one cloned theme and distill the in-process scan into a stable record. */
async function scanTheme(dir: string): Promise<ThemeScan> {
  const scan = await scanLiquid(dir);
  const { findingsCount, byRule, findings } = distillFindings(scan.findings, dir);
  const filesScanned = scan.files.length;
  const parseErrorCount = scan.parseErrors.length;
  return {
    filesScanned,
    findingsCount,
    parseErrorCount,
    parseErrorRate: filesScanned === 0 ? 0 : Math.round((parseErrorCount / filesScanned) * 10000) / 10000,
    byRule,
    findings,
  };
}

export async function runAll(): Promise<void> {
  await runManifest<ManifestEntry, ThemeScan>({
    manifestPath: MANIFEST_PATH,
    manifestKey: "themes",
    cacheDir: CACHE_DIR,
    resultsDir: RESULTS_DIR,
    cloneTimeoutMs: CLONE_TIMEOUT_MS,
    errPad: 20,
    scan: scanTheme,
    zero: { filesScanned: 0, findingsCount: 0, parseErrorCount: 0, parseErrorRate: 0, byRule: {}, findings: [] },
    logSuccess: (repo, scan) => {
      console.log(
        `${repo.padEnd(20)} files=${String(scan.filesScanned).padStart(4)}  ` +
          `findings=${String(scan.findingsCount).padStart(4)}  ` +
          `parseErrors=${String(scan.parseErrorCount).padStart(4)} ` +
          `(${(scan.parseErrorRate * 100).toFixed(1)}% of files skipped)`,
      );
    },
  });
}

if (import.meta.url === `file://${process.argv[1]}`) runAll();
