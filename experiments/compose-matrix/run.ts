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
 * BUILT before this runs; see README.md for the `./gradlew installDist` step. The
 * clone-at-SHA / result-loop skeleton is shared (`experiments/_matrix/harness.ts`,
 * #247).
 *
 * What this gate snapshots (#118): the FINDING stream — `findingsCount`, per-rule
 * counts (`byRule`), and the full sorted finding list. Compose has no secondary
 * parse-outcome layer (the engine emits findings only), so findings are the whole
 * snapshot. Results land in results/<owner>__<name>.json (gitignored — raw,
 * reproducible from the pinned manifest); the committed record is baseline.json.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scanKotlin } from "../../src/collect-kotlin.ts";
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
  readonly caveat?: string;
}

/** The stable per-repo scan result written to results/<slug>.json. The gated
 * quantity is the finding stream; the Compose engine emits findings only, so there
 * is no secondary parse-outcome layer to snapshot alongside them. */
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

type ComposeScan = Omit<ComposeResult, "repo" | "sha" | "pinned" | "error">;

/** Scan one cloned Compose repo and distill the out-of-process scan into a record.
 * The engine emits paths under the canonical `root` it scanned, so `relative(root,
 * …)` yields the repo-relative path the snapshot commits. */
async function scanRepo(dir: string): Promise<ComposeScan> {
  const scan = await scanKotlin(dir);
  return distillFindings(scan.findings, scan.root);
}

export async function runAll(): Promise<void> {
  await runManifest<ManifestEntry, ComposeScan>({
    manifestPath: MANIFEST_PATH,
    manifestKey: "repos",
    cacheDir: CACHE_DIR,
    resultsDir: RESULTS_DIR,
    cloneTimeoutMs: CLONE_TIMEOUT_MS,
    errPad: 28,
    scan: scanRepo,
    zero: { findingsCount: 0, byRule: {}, findings: [] },
    logSuccess: (repo, scan) => {
      const ruleBits = Object.entries(scan.byRule)
        .map(([id, n]) => `${id} ${n}`)
        .join(", ");
      console.log(
        `${repo.padEnd(28)} findings=${String(scan.findingsCount).padStart(4)}` +
          (ruleBits !== "" ? `  [${ruleBits}]` : ""),
      );
    },
  });
}

if (import.meta.url === `file://${process.argv[1]}`) runAll();
