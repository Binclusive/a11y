/**
 * The Liquid STATIC collector — L3 of the Shopify/Liquid producer (issue #50),
 * the 5th producer of {@link Finding}s, parallel to the jsx-a11y structural pass
 * (`core.ts`), the corpus enforce pass (`enforce.ts`), the rendered-DOM/axe pass
 * (`collect-dom.ts`), and the SwiftUI static pass (`collect-swift.ts`).
 *
 * Unlike the SwiftUI collector, the analysis is IN-process: L1 (`liquid-ast.ts`)
 * parses each `.liquid` file with `@shopify/liquid-html-parser` and L2
 * (`liquid-rules.ts`) applies the structural-absence rules. This module is the
 * THIN file walk + boundary: collect the `.liquid` files under a dir, parse each
 * (skipping — never crashing on — a malformed file), run the rules, and stamp the
 * contract-derived enforcement level onto every finding. The result mirrors
 * `scanSwift`'s shape so the `check-shopify` CLI runner is a sibling of
 * `runCheckSwift`.
 */

import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { contractForFiles, enforcementFor } from "./config-scan";
import type { Finding } from "./core";
import { parseLiquid } from "./liquid-ast";
import { runLiquidRules } from "./liquid-rules";

/** Build/vendor dirs that are not theme source — skipped on the walk, same set
 * the `.tsx` walk (`collect.ts`) and the SwiftUI walk skip. */
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".cache"]);

/**
 * Recursively collect `.liquid` files under `dir`, skipping build/vendor dirs.
 * A missing or unreadable directory yields `[]` rather than throwing — a
 * non-existent scan target is an empty scan, the same forgiving contract the
 * other collectors give the CLI.
 */
export async function collectLiquidFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...(await collectLiquidFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith(".liquid")) {
      out.push(full);
    }
  }
  return out;
}

/** One file the parser could not handle — surfaced as a skipped-count line in the
 * report, never as a crash (the precision invariant: one bad file must not take
 * down a whole-theme scan). */
export interface LiquidParseError {
  readonly file: string;
  readonly message: string;
}

/** The result of a `.liquid` theme scan — mirrors `SwiftScanResult` plus the
 * parse-error list the in-process parser can produce. */
export interface LiquidScanResult {
  readonly root: string;
  readonly files: readonly string[];
  readonly findings: readonly Finding[];
  readonly parseErrors: readonly LiquidParseError[];
}

/**
 * Scan `.liquid` theme source under `dir` for static structural a11y findings.
 *
 * Collects the files, finds the governing `binclusive.json` (package-up, the same
 * rule the jsx-a11y and SwiftUI scans use — with no contract every finding is
 * `block`), then for each file parses + runs the L2 rules and stamps the
 * contract-derived enforcement onto each finding (per-finding, exactly like
 * `scanSwift`). A file the parser rejects is recorded in `parseErrors` and
 * skipped — it never aborts the scan.
 */
export async function scanLiquid(dir: string): Promise<LiquidScanResult> {
  const root = resolve(dir);
  const files = await collectLiquidFiles(root);
  const contract = contractForFiles(files);

  const findings: Finding[] = [];
  const parseErrors: LiquidParseError[] = [];

  for (const file of files) {
    const source = await readFile(file, "utf8");
    const parsed = parseLiquid(source);
    if (!parsed.ok) {
      parseErrors.push({ file, message: parsed.error.message });
      continue;
    }
    const raw = runLiquidRules(parsed.ast, { file, source, enforcement: "block" });
    for (const finding of raw) {
      findings.push({ ...finding, enforcement: enforcementFor(finding.wcag, contract) });
    }
  }

  return { root, files, findings, parseErrors };
}
