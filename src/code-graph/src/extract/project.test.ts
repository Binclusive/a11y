import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadCheapProject } from "./project.js";

/**
 * Pins parse-failure detection (SPEC §11). The detection reads the parser's own
 * `@internal parseDiagnostics` through a typed module augmentation declared
 * optional — if a future ts-morph renames/removes that field it reads
 * `undefined`, `Array.isArray(undefined)` is false, and every file would be
 * silently reported parse-OK while CI stays green. This test feeds a
 * syntactically-broken file and a good file through `loadCheapProject` on a real
 * temp dir and asserts the broken one lands in `parseFailures` and the good one
 * does not — turning that silent regression into a red build.
 */
describe("loadCheapProject parse-failure detection (SPEC §11)", () => {
  let tmpRoot: string;

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "code-graph-parsefail-"));
    // Unclosed parameter list / function body — a real syntax error the TS
    // parser records in parseDiagnostics (it does not throw).
    fs.writeFileSync(path.join(tmpRoot, "broken.ts"), "export function f( {  // unclosed\n");
    fs.writeFileSync(
      path.join(tmpRoot, "good.ts"),
      "export function g(x: number): number {\n  return x + 1;\n}\n",
    );
  });

  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("reports the broken file and not the good file", () => {
    const loaded = loadCheapProject(tmpRoot);

    expect(loaded.parseFailures).toContain("broken.ts");
    expect(loaded.parseFailures).not.toContain("good.ts");
    // The good file is a clean, enumerable source.
    expect(loaded.sourceFiles.map((sf) => path.basename(sf.getFilePath()))).toContain("good.ts");
  });
});
