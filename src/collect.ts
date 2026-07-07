/**
 * Recursively collect the `.tsx` source files under a directory — the scan
 * target set shared by the `check` command and stack detection. Build and
 * generated dirs are skipped: generated Relay artifacts (`__generated__`) are
 * not source and would only add noise.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";

const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".turbo",
  "__generated__",
  ".git",
  "dist",
  // Test scaffolding is not shipped UI — its `.tsx` files are fixtures/specs,
  // not pages a visitor ever loads. Skipping the dir keeps both the scan and
  // stack detection focused on production code (Saleor's findings were ~20%
  // test scaffolding before this).
  "__tests__",
  "__mocks__",
]);

/**
 * A test/spec file by name: `Foo.test.tsx`, `Foo.spec.tsx`, and the `stories`
 * variants. These ship in the repo but never render to a real visitor, so an
 * a11y finding in one is noise, not a defect. Matched on the filename so it
 * holds regardless of directory layout.
 */
function isTestFile(name: string): boolean {
  return /\.(test|spec|stories)\.tsx$/.test(name);
}

/**
 * Recursively collect `.tsx` files under `dir`, skipping build/generated dirs
 * and test scaffolding (`*.test.tsx` / `*.spec.tsx`, `__tests__/`). Shipped UI
 * only — the unit under accessibility test.
 */
export async function collectTsx(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...(await collectTsx(full)));
    } else if (entry.isFile() && entry.name.endsWith(".tsx") && !isTestFile(entry.name)) {
      out.push(full);
    }
  }
  return out;
}
