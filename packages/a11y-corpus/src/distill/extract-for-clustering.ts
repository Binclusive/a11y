/**
 * Extract per-SC findings from a RAW export into a flat, gitignored worklist the
 * LLM reads to author the cluster files (`data/clusters/clusters-<SC>.json`).
 *
 * This is the *input side* of the offline clustering step. It is the mirror of
 * the determinism boundary: it strips every customer identifier the LLM does
 * NOT need to cluster (org_id, project_id, element selectors, urls) and emits
 * only the opaque finding id + the description/recommendation text the LLM
 * groups by meaning. The output is gitignored — it carries raw customer prose
 * (Turkish, customer names) and must never be committed; only the LLM's
 * generalized cluster files are.
 *
 * Usage:
 *   tsx src/distill/extract-for-clustering.ts <raw-export.json> <SC> [SC...]
 *
 * Writes `data/clusters/_worklist-<SC>.json` per SC: `[{ id, text }]` where
 * `text` is `description || recommendation`. The runner reads these by hand.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeCriterion } from "./normalize-sc";

const here = dirname(fileURLToPath(import.meta.url));
const CLUSTERS_DIR = join(here, "..", "..", "data", "clusters");

interface RawRow {
  readonly id: string;
  readonly wcag_criterion: string | null;
  readonly description: string | null;
  readonly recommendation: string | null;
}

function parseRows(json: unknown): RawRow[] {
  const rows = Array.isArray(json)
    ? json.length === 1 && typeof json[0] === "object" && json[0] !== null && "json_agg" in json[0]
      ? (json[0] as { json_agg: unknown }).json_agg
      : json
    : null;
  if (!Array.isArray(rows)) throw new Error("Unrecognized export shape");
  return rows.map((r): RawRow => {
    const row = r as Record<string, unknown>;
    const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
    return {
      id: typeof row.id === "string" ? row.id : "",
      wcag_criterion: str(row.wcag_criterion),
      description: str(row.description),
      recommendation: str(row.recommendation),
    };
  });
}

function main(): void {
  const [rawPath, ...scs] = process.argv.slice(2).filter((a) => a !== "--" && a !== "");
  if (rawPath === undefined || scs.length === 0) {
    console.error("usage: extract-for-clustering <raw-export.json> <SC> [SC...]");
    process.exitCode = 2;
    return;
  }
  const rows = parseRows(JSON.parse(readFileSync(rawPath, "utf8")));
  mkdirSync(CLUSTERS_DIR, { recursive: true });

  const scope = new Set(scs);
  const bySC = new Map<string, Array<{ id: string; text: string }>>();
  for (const r of rows) {
    for (const sc of normalizeCriterion(r.wcag_criterion)) {
      if (!scope.has(sc)) continue;
      const text = `${r.description ?? ""} || ${r.recommendation ?? ""}`.trim();
      const list = bySC.get(sc) ?? [];
      list.push({ id: r.id, text });
      bySC.set(sc, list);
    }
  }

  for (const sc of scs) {
    const list = bySC.get(sc) ?? [];
    const file = join(CLUSTERS_DIR, `_worklist-${sc}.json`);
    writeFileSync(file, `${JSON.stringify(list, null, 2)}\n`);
    console.log(`SC ${sc}: ${list.length} findings -> ${file}`);
  }
}

main();
