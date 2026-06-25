/**
 * The Android XML STATIC collector — the 6th producer of {@link Finding}s (ADR 0006),
 * parallel to the jsx-a11y pass (`core.ts`), enforce (`enforce.ts`), rendered-DOM
 * (`collect-dom.ts`), SwiftUI (`collect-swift.ts`), Liquid (`collect-liquid.ts`), and
 * Unity (`unity-findings.ts`).
 *
 * Like Liquid (and unlike Swift), the analysis is IN-process: `android-xml-ast.ts`
 * parses each layout and `android-xml-rules.ts` applies the structural-absence rules.
 * This is the first of the three Android lanes the ADR carves out — the cheap, no-JVM
 * one; the Compose + programmatic-Kotlin lanes land later behind an external Kotlin
 * engine and merge into the same `check-android` front door.
 *
 * This module is the THIN walk + boundary: collect the layout `.xml` under a dir,
 * parse each (recording — never crashing on — a malformed file), keep only Android
 * layouts (declare the android namespace; everything else stays opaque), run the
 * rules, and stamp the contract-derived enforcement onto every finding. The result
 * mirrors `LiquidScanResult` so the `check-android` runner is a sibling of
 * `runCheckShopify`.
 */

import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseAndroidXml, type XmlElement } from "./android-xml-ast";
import { runAndroidXmlRules } from "./android-xml-rules";
import { contractForFiles, enforcementFor } from "./config-scan";
import type { Finding } from "./core";

/** Build / IDE / vendor dirs that hold no hand-written layout source — skipped on
 * the walk, the same discipline the `.tsx`, `.liquid`, and `.swift` walks use. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".gradle",
  ".idea",
  "build",
  ".cxx",
  "dist",
  ".cache",
]);

/**
 * Recursively collect candidate `.xml` files under `dir`, skipping build/vendor dirs
 * and `AndroidManifest.xml` (it carries the android namespace but is not a layout).
 * A missing/unreadable directory yields `[]` rather than throwing — a non-existent
 * target is an empty scan, the forgiving contract the other collectors give the CLI.
 * The layout-vs-other-XML decision is made later, in {@link scanAndroidXml}, from the
 * parsed content (presence of the android namespace), not the path.
 */
export async function collectAndroidXmlFiles(dir: string): Promise<string[]> {
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
      out.push(...(await collectAndroidXmlFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith(".xml") && entry.name !== "AndroidManifest.xml") {
      out.push(full);
    }
  }
  return out;
}

/** One file the parser could not handle — surfaced as a skipped-count line in the
 * report, never as a crash (one bad file must not take down a whole-project scan). */
export interface AndroidXmlParseError {
  readonly file: string;
  readonly message: string;
}

/** The result of an Android layout scan — mirrors `LiquidScanResult`. `files` is the
 * layout files actually SCANNED (android-namespaced), not every `.xml` collected. */
export interface AndroidXmlScanResult {
  readonly root: string;
  readonly files: readonly string[];
  readonly findings: readonly Finding[];
  readonly parseErrors: readonly AndroidXmlParseError[];
}

/**
 * Scan Android layout XML under `dir` for static structural a11y findings.
 *
 * Collects candidate `.xml`, parses each once (recording parse failures, skipping
 * non-layout XML), finds the governing `binclusive.json` (package-up, the same rule
 * every other static scan uses — with no contract every finding is `block`), runs the
 * rules, and stamps the contract-derived enforcement per finding (exactly like
 * `scanLiquid`).
 */
export async function scanAndroidXml(dir: string): Promise<AndroidXmlScanResult> {
  const root = resolve(dir);
  const candidates = await collectAndroidXmlFiles(root);

  const parsed: { file: string; elements: readonly XmlElement[] }[] = [];
  const parseErrors: AndroidXmlParseError[] = [];
  for (const file of candidates) {
    const source = await readFile(file, "utf8");
    const result = parseAndroidXml(source);
    if (!result.ok) {
      parseErrors.push({ file, message: result.error.message });
      continue;
    }
    // Not an Android layout (no android namespace) → stay opaque, don't scan it.
    if (!result.isLayout) continue;
    parsed.push({ file, elements: result.elements });
  }

  const files = parsed.map((p) => p.file);
  const contract = contractForFiles(files);

  const findings: Finding[] = [];
  for (const { file, elements } of parsed) {
    const raw = runAndroidXmlRules(elements, { file, enforcement: "block" });
    for (const finding of raw) {
      findings.push({ ...finding, enforcement: enforcementFor(finding.wcag, contract) });
    }
  }

  return { root, files, findings, parseErrors };
}
