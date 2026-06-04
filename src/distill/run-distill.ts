/**
 * Distill runner: read a RAW corpus export (gitignored — never committed) plus
 * the committed LLM-authored cluster files, distill the requested SCs, and write
 * ONLY the anonymized patterns + ledger to `data/corpus/`.
 *
 * Usage:
 *   tsx src/distill/run-distill.ts <raw-export.json> <SC> [SC...]
 *
 * For each SC, the runner loads `data/clusters/clusters-<SC>.json` (the frozen
 * LLM clustering artifact). The raw export supplies org_id (for the k>=3 gate,
 * stripped before output) and the join keys / journeys; the cluster files
 * supply the generic, anonymized failure-shape prose. The LLM never runs here —
 * its judgment is already baked into the committed cluster files.
 *
 * The raw export is the drizzle `json_agg` shape: `[{ json_agg: RawFinding[] }]`.
 * Output files (committed):
 *   data/corpus/patterns-<SC>.json   — the shipped patterns
 *   data/corpus/ledger-<SC>.json     — the no-silent-drops report
 *
 * The raw input is read here and only aggregate, anonymized data is written —
 * org_id/project_id/element/urls never leave this process.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ParsedClusters, parseClusterFile } from "./cluster-assignments";
import { distill, type RawFinding } from "./distill";

const here = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(here, "..", "..", "data", "corpus");
const CLUSTERS_DIR = join(here, "..", "..", "data", "clusters");

/** Narrow an unknown JSON value into RawFinding[] without trusting its shape. */
function parseRawExport(json: unknown): RawFinding[] {
  // drizzle export: [{ json_agg: [...] }]; tolerate a bare array too.
  const rows = Array.isArray(json)
    ? json.length === 1 && typeof json[0] === "object" && json[0] !== null && "json_agg" in json[0]
      ? (json[0] as { json_agg: unknown }).json_agg
      : json
    : null;
  if (!Array.isArray(rows)) {
    throw new Error("Unrecognized export shape: expected an array or [{ json_agg: [...] }]");
  }
  return rows.map((r): RawFinding => {
    const row = r as Record<string, unknown>;
    const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
    return {
      id: typeof row.id === "string" ? row.id : "",
      wcag_criterion: str(row.wcag_criterion),
      org_id: str(row.org_id),
      journey_name: str(row.journey_name),
      journey_step: str(row.journey_step),
    };
  });
}

/** Load the committed cluster file for each SC; missing files fail loud. */
function loadClusters(scs: readonly string[]): Map<string, ParsedClusters> {
  const map = new Map<string, ParsedClusters>();
  for (const sc of scs) {
    const file = join(CLUSTERS_DIR, `clusters-${sc}.json`);
    if (!existsSync(file)) {
      throw new Error(`no cluster file for SC ${sc} (expected ${file}) — author it first`);
    }
    const parsed = parseClusterFile(JSON.parse(readFileSync(file, "utf8")));
    if (parsed.sc !== sc) {
      throw new Error(`cluster file ${file} declares sc=${parsed.sc}, expected ${sc}`);
    }
    map.set(sc, parsed);
  }
  return map;
}

function main(): void {
  const [rawPath, ...scs] = process.argv.slice(2).filter((a) => a !== "--" && a !== "");
  if (rawPath === undefined || scs.length === 0) {
    console.error("usage: run-distill <raw-export.json> <SC> [SC...]");
    process.exitCode = 2;
    return;
  }

  const raw = parseRawExport(JSON.parse(readFileSync(rawPath, "utf8")));
  const clusters = loadClusters(scs);
  const result = distill(raw, clusters);

  mkdirSync(OUT_DIR, { recursive: true });
  const scLabel = scs.join("_");

  const patternsFile = join(OUT_DIR, `patterns-${scLabel}.json`);
  const ledgerFile = join(OUT_DIR, `ledger-${scLabel}.json`);

  writeFileSync(
    patternsFile,
    `${JSON.stringify(
      {
        _meta: {
          note: "ANONYMIZED, English, k>=3-org distilled patterns from Binclusive's dynamic-audit corpus. Failure-shapes clustered offline by LLM (frozen in data/clusters/), gated k>=3-distinct-org and anonymized by deterministic code. Contains NO customer identifiers (org/project ids, elements, urls stripped; frequency as tier only). Regenerate by re-running the distiller.",
          scope: scs,
          corpusFindings: result.totalFindings,
          corpusOrgs: result.totalOrgs,
        },
        patterns: result.patterns,
      },
      null,
      2,
    )}\n`,
  );

  writeFileSync(`${ledgerFile}`, `${JSON.stringify(result.ledger, null, 2)}\n`);

  // Console summary (safe — counts only).
  console.log(`distilled ${result.totalFindings} findings across ${result.totalOrgs} orgs`);
  console.log(`scope: ${scs.join(", ")}`);
  console.log(`kept patterns (k>=3): ${result.patterns.length}`);
  console.log(
    `dropped — unmappable criterion: ${result.ledger.unmappableCriterion} | out-of-scope SC: ${result.ledger.scOutOfScope} | unclassified: ${result.ledger.unclassified} | below-k clusters: ${result.ledger.belowK.length} (${result.ledger.belowK.reduce((n, d) => n + d.findings, 0)} findings)`,
  );
  console.log(`wrote ${patternsFile}`);
  console.log(`wrote ${ledgerFile}`);
}

main();
