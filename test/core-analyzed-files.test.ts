import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scan } from "../src/core";

/**
 * `ScanResult.analyzedFiles` is the source-scan-scope coverage set (ADR 0043): the
 * files the run SUCCESSFULLY ANALYZED. The whole no-false-resolve guarantee rests on
 * TWO halves — INCLUDE zero-finding analyzed files (so a fixed file's ticket can
 * resolve), EXCLUDE files that failed to parse (`fatalErrorCount > 0` — attempted ≠
 * analyzed; else a file we never read false-resolves its ticket).
 */
describe("scan().analyzedFiles — analyzed set, incl zero-finding, excl fatal-parse", () => {
  let dir: string;
  const endsWith = (paths: readonly string[], name: string) => paths.some((p) => p.endsWith(name));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "analyzed-files-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("INCLUDES a clean zero-finding file and a with-finding file; EXCLUDES a fatal-parse file", async () => {
    // Zero findings — a fixed/clean file. MUST be present so its old ticket resolves.
    const clean = join(dir, "clean.tsx");
    writeFileSync(clean, "export const A = () => <div>hello</div>;\n");
    // A real a11y finding (img with no alt). Analyzed, so also present.
    const withFinding = join(dir, "withFinding.tsx");
    writeFileSync(withFinding, "export const B = () => <img />;\n");
    // A fatal parse error (unterminated) — attempted but NOT analyzed. MUST be absent.
    const broken = join(dir, "broken.tsx");
    writeFileSync(broken, "export const C = () => <div\n");

    const result = await scan([clean, withFinding, broken]);

    // The clean zero-finding file is IN the analyzed set (the load-bearing inclusion).
    expect(endsWith(result.analyzedFiles, "clean.tsx")).toBe(true);
    expect(endsWith(result.analyzedFiles, "withFinding.tsx")).toBe(true);
    // The parse-failed file is OUT (the load-bearing exclusion — no false-resolve).
    expect(endsWith(result.analyzedFiles, "broken.tsx")).toBe(false);
  });

  it("empty scan → empty analyzedFiles", async () => {
    const result = await scan([]);
    expect(result.analyzedFiles).toEqual([]);
  });
});
