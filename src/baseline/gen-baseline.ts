/**
 * Generate the BASELINE RULE CATALOG (`data/baseline-rules.json`) from
 * axe-core's own published per-rule metadata.
 *
 * WHY this exists — the two-source-of-truth split:
 *   1. CORPUS frequency (the moat) — `data/corpus-snapshot.json` + the distilled
 *      `data/corpus/patterns-*.json` — comes from REAL audits of ~26 orgs. It is
 *      truthful, partial (~15 SCs), and carries org counts / frequency tiers.
 *   2. BASELINE catalog (this file's output) — derived MECHANICALLY from
 *      axe-core's rule metadata. Covers EVERY axe rule, so a finding for an SC
 *      the corpus has never seen still surfaces with a WCAG SC, a severity, and a
 *      concrete fix instead of dead-ending at `unknown`.
 *
 * These two NEVER mix: the baseline carries NO org count and NO frequency tier.
 * It is honest because every field is axe's published per-rule data, not our
 * audit data.
 *
 * SOURCES (all from the installed axe-core package, nothing fabricated):
 *   - `axe.getRules()` → `ruleId`, `help`, `helpUrl`, `tags`. The SC array is
 *     parsed from the `wcag<NNN>` tags via the SHARED `scFromTags` (the same
 *     function the live-DOM collector uses), so axe tags and corpus keys line up.
 *   - `axe._audit.rules[].impact` → the per-rule default SEVERITY
 *     (`minor|moderate|serious|critical`). `getRules()` does NOT expose impact,
 *     but the audit's rule objects do, and every one of axe's rules carries a
 *     valid level (verified: 104/104, none null). This is axe's own published
 *     default impact — NOT a fabricated value. The runtime per-node impact on an
 *     axe finding (see `collect-dom.ts`) is still more accurate and wins when
 *     present; this static value is the fallback for source-pass findings that
 *     fall back to the baseline by SC.
 *
 * DETERMINISTIC + RE-RUNNABLE: rules are sorted by `ruleId`, SC arrays are
 * deduped and sorted, and the JSON is written with stable 2-space formatting +
 * a trailing newline, so re-running with the same axe-core version is a no-op
 * diff. Run with: `pnpm gen:baseline` (or `tsx src/baseline/gen-baseline.ts`).
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { scFromTags } from "../wcag-tags";

/** One baseline rule entry as written to `data/baseline-rules.json`. */
export interface BaselineRule {
  /** The axe rule id, e.g. `color-contrast`. */
  readonly ruleId: string;
  /** WCAG SC(s) parsed from the rule's `wcag<NNN>` tags (deduped, sorted). */
  readonly sc: readonly string[];
  /** axe's default per-rule severity. */
  readonly severity: "minor" | "moderate" | "serious" | "critical";
  /** axe's short, imperative remediation summary (`help`). */
  readonly help: string;
  /** axe's Deque-University help URL for the rule. */
  readonly helpUrl: string;
}

/** The shape `data/baseline-rules.json` carries: provenance meta + the rules. */
export interface BaselineCatalogFile {
  readonly _meta: {
    readonly note: string;
    readonly source: string;
    readonly axeVersion: string;
    readonly ruleCount: number;
  };
  readonly rules: readonly BaselineRule[];
}

const VALID_IMPACTS = new Set(["minor", "moderate", "serious", "critical"]);

/**
 * Resolve and load axe-core through the same module graph the runtime uses
 * (`@axe-core/playwright` → `axe-core`), so the generator and the live collector
 * read identical rule metadata. Returns the axe module typed loosely — we only
 * touch `getRules()`, `version`, and `_audit.rules`.
 */
interface AxeRuleMeta {
  readonly ruleId: string;
  readonly help: string;
  readonly helpUrl: string;
  readonly tags: readonly string[];
}
interface AxeAuditRule {
  readonly id: string;
  readonly impact?: string | null;
}
interface AxeModule {
  readonly version: string;
  getRules(): AxeRuleMeta[];
  readonly _audit?: { readonly rules: readonly AxeAuditRule[] };
}

function loadAxe(require: NodeJS.Require): AxeModule {
  // Prefer the axe-core that @axe-core/playwright pulls in (the runtime path),
  // so the catalog matches the version that actually scans live pages.
  try {
    const apMain = require.resolve("@axe-core/playwright");
    const axePath = require.resolve("axe-core", { paths: [dirname(apMain)] });
    return require(axePath) as AxeModule;
  } catch {
    return require("axe-core") as AxeModule;
  }
}

/**
 * Build the baseline catalog from a loaded axe module. Pure transform — no I/O —
 * so a test can call it directly to assert the output shape without writing the
 * file. The per-rule default impact comes from `_audit.rules`, keyed by id.
 */
export function buildBaselineCatalog(axe: AxeModule): BaselineCatalogFile {
  const impactById = new Map<string, "minor" | "moderate" | "serious" | "critical">();
  for (const r of axe._audit?.rules ?? []) {
    if (typeof r.impact === "string" && VALID_IMPACTS.has(r.impact)) {
      impactById.set(r.id, r.impact as "minor" | "moderate" | "serious" | "critical");
    }
  }

  const rules: BaselineRule[] = [];
  for (const r of axe.getRules()) {
    const severity = impactById.get(r.ruleId);
    // Every axe rule carries a valid default impact; if a future axe version
    // ever omits one, default to the conservative middle ("moderate") rather
    // than fabricating a high/low signal or dropping the rule from coverage.
    const sc = [...new Set(scFromTags(r.tags))].sort();
    rules.push({
      ruleId: r.ruleId,
      sc,
      severity: severity ?? "moderate",
      help: r.help,
      helpUrl: r.helpUrl,
    });
  }
  rules.sort((a, b) => (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0));

  return {
    _meta: {
      note: "BASELINE rule catalog — coverage layer, NOT audit-frequency data. Generated mechanically from axe-core's published per-rule metadata (getRules() + axe._audit.rules[].impact). Covers every axe/WCAG rule with a WCAG SC, axe's default severity, a standard fix (help), and a helpUrl. Carries NO org count and NO frequency tier — those live only in the corpus snapshot (the real-audit moat). Regenerate with `pnpm gen:baseline`.",
      source: "axe-core getRules() + axe._audit.rules[].impact",
      axeVersion: axe.version,
      ruleCount: rules.length,
    },
    rules,
  };
}

/** Stable serialization: 2-space JSON + trailing newline for a clean diff. */
function serialize(catalog: BaselineCatalogFile): string {
  return `${JSON.stringify(catalog, null, 2)}\n`;
}

function main(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const require = createRequire(import.meta.url);
  const axe = loadAxe(require);
  const catalog = buildBaselineCatalog(axe);
  const outPath = join(here, "..", "..", "data", "baseline-rules.json");
  writeFileSync(outPath, serialize(catalog));
  console.log(
    `wrote ${catalog.rules.length} baseline rules (axe-core ${catalog._meta.axeVersion}) → ${outPath}`,
  );
}

// Run only when invoked directly (the generator), not on import — so a test can
// import `buildBaselineCatalog` without triggering a file write.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
