import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Fast unit coverage for the Jetpack Compose collector boundary — NO real Gradle
 * build. Three concerns, mirroring `collect-swift.test.ts`:
 *   1. `parseKotlinFindings` narrows the engine's stdout (valid kept, malformed
 *      dropped, non-JSON throws a clear one-line error).
 *   2. `scanKotlin` surfaces an engine spawn/exit failure as a rejected promise —
 *      the toolchain-absent surface the CLI degrades on — and maps a clean exit
 *      into `compose`-provenance findings.
 *   3. the `check-kotlin` CLI command prints a usage error + exits non-zero with
 *      no dir.
 * The engine process is MOCKED (`node:child_process.spawn`), so nothing here
 * compiles Kotlin or needs a JVM.
 */

// ── 1. parseKotlinFindings: the JSON boundary ───────────────────────────────
import { parseKotlinFindings, scanKotlin } from "../src/collect-kotlin";

describe("parseKotlinFindings: engine stdout → validated findings", () => {
  const valid = {
    file: "/abs/Screen.kt",
    line: 17,
    ruleId: "compose/image-no-label",
    message: "Image has no contentDescription",
    wcag: ["1.1.1"],
    severity: "serious",
  };

  it("keeps a fully-valid record", () => {
    const out = parseKotlinFindings(JSON.stringify([valid]));
    expect(out).toHaveLength(1);
    expect(out[0]!.ruleId).toBe("compose/image-no-label");
  });

  it("drops malformed records but keeps the valid ones in the same array", () => {
    const records = [
      valid, // ok
      { ...valid, line: "17" }, // line not a number → dropped
      { ...valid, ruleId: "compose/unknown-rule" }, // unknown rule id → dropped
      { ...valid, severity: "minor" }, // severity not serious|critical → dropped
      { ...valid, wcag: [1, 2] }, // wcag not all strings → dropped
      null, // not an object → dropped
      { ...valid, severity: "critical", line: 18 }, // ok
    ];
    const out = parseKotlinFindings(JSON.stringify(records));
    expect(out).toHaveLength(2);
    expect(out.map((f) => f.severity)).toEqual(["serious", "critical"]);
  });

  it("returns [] for empty stdout", () => {
    expect(parseKotlinFindings("")).toEqual([]);
    expect(parseKotlinFindings("   \n")).toEqual([]);
  });

  it("returns [] when the top-level JSON is not an array", () => {
    expect(parseKotlinFindings('{"file":"x"}')).toEqual([]);
  });

  it("throws a clear one-line error on non-JSON stdout", () => {
    expect(() => parseKotlinFindings("not json at all")).toThrowError(
      /A11yKotlinScan produced non-JSON output/,
    );
  });
});

// ── 2. scanKotlin: engine failure / clean-exit handling ─────────────────────
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn() };
});
// Force the `./gradlew run` fallback path (no prebuilt launcher) so the mocked
// spawn is always what runs, regardless of whether an installDist build exists.
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

describe("scanKotlin: engine failure handling", () => {
  afterEach(() => vi.mocked(spawn).mockReset());

  it("rejects with a one-line error when the engine exits non-zero", async () => {
    // A non-zero exit is the toolchain-absent surface (e.g. gradlew reporting no
    // JAVA_HOME) — `runCheckKotlin` catches this and prints the message.
    vi.mocked(spawn).mockReturnValue(
      fakeChild({ stderr: "ERROR: JAVA_HOME is not set", code: 1 }) as never,
    );
    await expect(scanKotlin("/no/such/dir")).rejects.toThrow(
      /A11yKotlinScan exited with code 1/,
    );
  });

  it("returns the canonical root + compose findings on a clean exit", async () => {
    vi.mocked(spawn).mockReturnValue(
      fakeChild({
        stdout: JSON.stringify([
          {
            file: "/abs/Screen.kt",
            line: 17,
            ruleId: "compose/image-no-label",
            message: "Image has no contentDescription",
            wcag: ["1.1.1"],
            severity: "serious",
          },
        ]),
        code: 0,
      }) as never,
    );
    const result = await scanKotlin("/abs");
    expect(typeof result.root).toBe("string");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.provenance).toBe("compose");
    // severity is folded into the message so the report path surfaces it
    expect(result.findings[0]!.message).toMatch(/^\[serious\]/);
  });
});

// ── 3. CLI usage error: `check-kotlin` with no dir ──────────────────────────
const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "src", "cli.ts");
const run = promisify(execFile);

describe("CLI: check-kotlin usage", () => {
  // Spawns the real CLI through the local `tsx` loader; the first cold start of
  // the TS transform can take several seconds, so the timeout is generous.
  // `check-kotlin` declares `dir` as a REQUIRED positional, so `@effect/cli`
  // rejects a missing arg before the runner is reached — no JVM is spawned.
  it(
    "fails with a missing-argument error when no dir is given",
    async () => {
      const tsx = join(here, "..", "node_modules", ".bin", "tsx");
      try {
        await run(tsx, [cli, "check-kotlin"], { cwd: join(here, "..") });
        throw new Error("expected non-zero exit");
      } catch (err) {
        const e = err as { code?: number; stderr?: string; stdout?: string };
        expect(e.code).not.toBe(0);
        const output = `${e.stderr ?? ""}${e.stdout ?? ""}`;
        expect(output).toMatch(/Missing argument <dir>/);
      }
    },
    30_000,
  );
});
