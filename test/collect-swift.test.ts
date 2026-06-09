import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Fast unit coverage for the SwiftUI collector boundary — NO real `swift` build.
 * Three concerns:
 *   1. `parseSwiftFindings` narrows the engine's stdout (valid kept, malformed
 *      dropped, non-JSON throws a clear one-line error).
 *   2. `scanSwift` surfaces an engine spawn/exit failure as a rejected promise.
 *   3. the `check-swift` CLI command prints a usage error + exits 2 with no dir.
 * The engine process is MOCKED (`node:child_process.spawn`), so nothing here
 * compiles Swift or touches the e2e/browser path.
 */

// ── 1. parseSwiftFindings: the JSON boundary ────────────────────────────────
import { parseSwiftFindings, scanSwift } from "../src/collect-swift";

describe("parseSwiftFindings: engine stdout → validated findings", () => {
  const valid = {
    file: "/abs/View.swift",
    line: 12,
    ruleId: "swiftui/image-no-label",
    message: "Image has no accessible name",
    wcag: ["1.1.1"],
    severity: "serious",
  };

  it("keeps a fully-valid record", () => {
    const out = parseSwiftFindings(JSON.stringify([valid]));
    expect(out).toHaveLength(1);
    expect(out[0]!.ruleId).toBe("swiftui/image-no-label");
  });

  it("drops malformed records but keeps the valid ones in the same array", () => {
    const records = [
      valid, // ok
      { ...valid, line: "12" }, // line not a number → dropped
      { ...valid, ruleId: "swiftui/unknown-rule" }, // unknown rule id → dropped
      { ...valid, severity: "minor" }, // severity not serious|critical → dropped
      { ...valid, wcag: [1, 2] }, // wcag not all strings → dropped
      null, // not an object → dropped
      { ...valid, ruleId: "swiftui/control-no-name", severity: "critical" }, // ok
    ];
    const out = parseSwiftFindings(JSON.stringify(records));
    expect(out).toHaveLength(2);
    expect(out.map((f) => f.ruleId)).toEqual([
      "swiftui/image-no-label",
      "swiftui/control-no-name",
    ]);
  });

  it("returns [] for empty stdout", () => {
    expect(parseSwiftFindings("")).toEqual([]);
    expect(parseSwiftFindings("   \n")).toEqual([]);
  });

  it("returns [] when the top-level JSON is not an array", () => {
    expect(parseSwiftFindings('{"file":"x"}')).toEqual([]);
  });

  it("throws a clear one-line error on non-JSON stdout", () => {
    expect(() => parseSwiftFindings("not json at all")).toThrowError(
      /A11ySwiftScan produced non-JSON output/,
    );
  });
});

// ── 2. scanSwift: engine failure surfaces as a rejected promise ─────────────
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn() };
});
// Force the `swift run` fallback path (no prebuilt binary) so the mocked spawn
// is always what runs, regardless of whether a release build exists on disk.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: () => false };
});

import { spawn } from "node:child_process";

/** A fake child process that emits the given stdout/stderr then closes. */
function fakeChild(opts: { stdout?: string; stderr?: string; code: number }) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  queueMicrotask(() => {
    if (opts.stdout) child.stdout.emit("data", Buffer.from(opts.stdout));
    if (opts.stderr) child.stderr.emit("data", Buffer.from(opts.stderr));
    child.emit("close", opts.code);
  });
  return child;
}

describe("scanSwift: engine failure handling", () => {
  afterEach(() => vi.mocked(spawn).mockReset());

  it("rejects with a one-line error when the engine exits non-zero", async () => {
    vi.mocked(spawn).mockReturnValue(
      fakeChild({ stderr: "swift: toolchain missing", code: 70 }) as never,
    );
    await expect(scanSwift("/no/such/dir")).rejects.toThrow(
      /A11ySwiftScan exited with code 70/,
    );
  });

  it("returns the canonical root + findings on a clean exit", async () => {
    vi.mocked(spawn).mockReturnValue(
      fakeChild({
        stdout: JSON.stringify([
          {
            file: "/abs/View.swift",
            line: 3,
            ruleId: "swiftui/control-no-name",
            message: "Icon-only Button has no accessible name",
            wcag: ["4.1.2"],
            severity: "serious",
          },
        ]),
        code: 0,
      }) as never,
    );
    const result = await scanSwift("/abs");
    expect(typeof result.root).toBe("string");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.provenance).toBe("swiftui");
  });
});

// ── 3. CLI usage error: `check-swift` with no dir ───────────────────────────
const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "src", "cli.ts");
const run = promisify(execFile);

describe("CLI: check-swift usage", () => {
  // Spawns the real CLI through the local `tsx` loader; the first cold start of
  // the TS transform can take several seconds, so the timeout is generous.
  it(
    "exits 2 with a usage message when no dir is given",
    async () => {
      const tsx = join(here, "..", "node_modules", ".bin", "tsx");
      try {
        await run(tsx, [cli, "check-swift"], { cwd: join(here, "..") });
        throw new Error("expected non-zero exit");
      } catch (err) {
        const e = err as { code?: number; stderr?: string };
        expect(e.code).toBe(2);
        expect(e.stderr ?? "").toMatch(/usage: a11y-checker check-swift <dir>/);
      }
    },
    30_000,
  );
});
