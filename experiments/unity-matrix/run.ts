/**
 * run.ts — clone each SHA-pinned Unity repo and scan it with the Unity finding
 * aggregator IN-PROCESS, writing one stable result JSON per repo.
 *
 * We import {@link collectUnityFindings} from `src/unity-findings` DIRECTLY — the
 * Unity analysis is in-process (no subprocess, no network beyond the clone), so
 * calling the function is both faster and more deterministic than shelling a CLI.
 * The clone-at-SHA / result-loop skeleton is shared with every matrix gate
 * (`experiments/_matrix/harness.ts`, #247).
 *
 * The PRIMARY gated quantity is the FINDING stream — count, per-rule counts, and
 * the full sorted finding list (#88's aggregator). Parse-outcome coverage is kept
 * as a SECONDARY assertion (`scanUnity` is run alongside): `assetsScanned` /
 * `graphCount` / `opaqueBinary` / `opaqueParseError` are snapshotted so the
 * Force-Text precision seam stays visible (ADR 0004: a binary asset is reported
 * OPAQUE, not silently skipped), and they are diffed too — a regression that starts
 * silently dropping real UI assets is a visible delta. Results land in
 * results/<owner>__<name>.json (gitignored); the committed record is baseline.json.
 */

import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { scanUnity } from "../../src/collect-unity.ts";
import { collectUnityFindings } from "../../src/unity-findings.ts";
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
  readonly uiSystem: string;
  readonly source: string;
  readonly caveat?: string;
}

/** The stable per-repo scan result written to results/<slug>.json.
 *
 * The PRIMARY gated quantity is the finding stream (`findingsCount` / `byRule` /
 * `findings`). The parse-outcome fields (`assetsScanned` / `graphCount` /
 * `opaqueBinary` / `opaqueParseError` / `opaqueRate` / `opaqueAssets`) are kept as
 * a SECONDARY assertion so opaque stays visible (ADR 0004):
 * `graphCount + opaqueBinary + opaqueParseError == assetsScanned` by construction,
 * so a silently-dropped asset surfaces as a sum mismatch. */
export interface UnityResult {
  readonly repo: string;
  readonly sha: string;
  /** Whether the clone is parked at the manifest sha. false ⇒ a delta may be drift. */
  readonly pinned: boolean;
  /** Total findings the aggregator emitted over the repo. */
  readonly findingsCount: number;
  /** ruleId -> count, so a diff can say "unity/missing-accessible-label +3" not just "findings +3". */
  readonly byRule: Record<string, number>;
  /** Every finding, sorted by (file, line, ruleId) for a stable, reviewable diff. */
  readonly findings: readonly ResultFinding[];
  /** uGUI prefab/scene YAML assets walked (.prefab + .unity) — secondary (ADR 0004). */
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

type UnityScan = Omit<UnityResult, "repo" | "sha" | "pinned" | "error">;

const sortOpaque = (a: { file: string; reason: string }, b: { file: string; reason: string }): number =>
  a.file !== b.file ? (a.file < b.file ? -1 : 1) : a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0;

/** Scan one cloned Unity repo and distill the in-process scan into a stable record. */
async function scanRepo(dir: string): Promise<UnityScan> {
  // PRIMARY: the finding stream (#88 aggregator), the quantity the gate is built on.
  const primary = distillFindings(await collectUnityFindings(dir), dir);

  // SECONDARY: parse outcome, so opaque stays visible (ADR 0004).
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
    ...primary,
    assetsScanned,
    graphCount,
    opaqueBinary,
    opaqueParseError,
    opaqueRate: assetsScanned === 0 ? 0 : Math.round((opaqueTotal / assetsScanned) * 10000) / 10000,
    opaqueAssets,
  };
}

export async function runAll(): Promise<void> {
  await runManifest<ManifestEntry, UnityScan>({
    manifestPath: MANIFEST_PATH,
    manifestKey: "repos",
    cacheDir: CACHE_DIR,
    resultsDir: RESULTS_DIR,
    cloneTimeoutMs: CLONE_TIMEOUT_MS,
    errPad: 34,
    scan: scanRepo,
    zero: {
      findingsCount: 0,
      byRule: {},
      findings: [],
      assetsScanned: 0,
      graphCount: 0,
      opaqueBinary: 0,
      opaqueParseError: 0,
      opaqueRate: 0,
      opaqueAssets: [],
    },
    logSuccess: (repo, scan) => {
      console.log(
        `${repo.padEnd(34)} findings=${String(scan.findingsCount).padStart(4)}  ` +
          `assets=${String(scan.assetsScanned).padStart(4)}  ` +
          `graph=${String(scan.graphCount).padStart(4)}  ` +
          `opaque=${String(scan.opaqueBinary + scan.opaqueParseError).padStart(3)} ` +
          `(bin=${scan.opaqueBinary} parse=${scan.opaqueParseError}, ${(scan.opaqueRate * 100).toFixed(1)}%)`,
      );
    },
  });
}

if (import.meta.url === `file://${process.argv[1]}`) runAll();
