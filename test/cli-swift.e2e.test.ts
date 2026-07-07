import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeContext } from "@effect/platform-node";
import { Effect, Exit } from "effect";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli";

/**
 * END-TO-END test for the `check-swift` CLI route.
 *
 * This is the ONLY test that drives `check-swift` through the REAL Swift engine
 * (`runCli` → `runCheckSwift` → `scanSwift` → the `swift`/A11ySwiftScan spawn in
 * `src/collect-swift.ts`). With no prebuilt release binary on disk it falls back
 * to `swift run -c release`, which COMPILES the engine package on first use — a
 * cold/slow-Swift machine takes well over vitest's 30s default for that compile.
 *
 * GATING — this file lives in the slow `*.e2e.test.ts` tier, EXCLUDED from the
 * default `pnpm test` (unit) run via `**\/*.e2e.test.ts` in vitest.config.ts, so
 * the unit suite stays fast and toolchain-free (issue #79: this real-toolchain
 * route used to time out the default gate on a cold-Swift machine, making
 * `pnpm test` perpetually one-short). Run it explicitly on a machine with a
 * (warm or prebuilt) Swift toolchain:
 *
 *     pnpm test:e2e
 *
 * The fast, mocked-engine coverage of the same boundary (parse, scan failure,
 * the required-arg parse route) stays in `test/collect-swift.test.ts`, which
 * never compiles Swift — so the unit gate keeps proving the boundary without
 * the toolchain. This file is the regression guard for the real spawn → JSON →
 * `Finding` → empty-state-render seam that only a genuine engine run exercises.
 */

/**
 * Run the root command with `args` (the verb + its flags), capturing stdout.
 * The first two argv slots stand in for `node` + the script path, which
 * `Command.run` strips. Returns the captured stdout/stderr and the run `Exit`.
 */
async function runVerb(args: readonly string[]): Promise<{
  stdout: string;
  stderr: string;
  exit: Exit.Exit<void, unknown>;
}> {
  const out: string[] = [];
  const err: string[] = [];
  const logSpy = vi.spyOn(console, "log").mockImplementation((...a) => {
    out.push(a.join(" "));
  });
  const errSpy = vi.spyOn(console, "error").mockImplementation((...a) => {
    err.push(a.join(" "));
  });
  process.exitCode = undefined;
  try {
    const exit = await Effect.runPromiseExit(
      runCli(["node", "a11y-checker", ...args]).pipe(Effect.provide(NodeContext.layer)),
    );
    return { stdout: out.join("\n"), stderr: err.join("\n"), exit };
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
  }
}

let emptyDir: string;
beforeAll(async () => {
  emptyDir = await mkdtemp(join(tmpdir(), "a11y-cli-swift-e2e-"));
});
afterAll(async () => {
  await rm(emptyDir, { recursive: true, force: true });
});

const savedExitCode = process.exitCode;
beforeEach(() => {
  process.exitCode = undefined;
});
afterEach(() => {
  process.exitCode = savedExitCode;
});

// A cold `swift run -c release` compiles the engine (and its SwiftSyntax deps)
// on first use; give that real build generous room since this tier is off the
// fast gate. A prebuilt release binary makes the same run near-instant.
const SWIFT_E2E_TIMEOUT_MS = 180_000;

describe("check-swift CLI route (e2e, spawns the real Swift engine)", () => {
  it(
    "`check-swift <dir>` routes to runCheckSwift",
    { timeout: SWIFT_E2E_TIMEOUT_MS },
    async () => {
      // An empty dir has no .swift files: scanSwift returns zero findings, the
      // runner prints its empty-state and exits clean — proving the verb
      // dispatched all the way through the real engine.
      const { stdout, exit } = await runVerb(["check-swift", emptyDir]);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(stdout).toContain("No SwiftUI a11y violations found.");
    },
  );

  it(
    "accepts the unified gate + output-format flags and dispatches identically across formats (#176)",
    { timeout: SWIFT_E2E_TIMEOUT_MS },
    async () => {
      // `check-swift` now mounts the SAME `gateOptions` as `check` — parse `--format`
      // / `--json` / `--fail-on` / `--max-violations` and route through the shared
      // `reportStack` gate. An empty dir yields no findings, so the exit is 0 for
      // every format; the block-level-finding exit-code parity (text=json=sarif)
      // rides the same shared path proven in `cli-stack-gate.test.ts` on the three
      // in-process stacks, which never compile Swift.
      process.exitCode = undefined;
      const text = await runVerb(["check-swift", emptyDir, "--max-violations", "0"]);
      const json = await runVerb(["check-swift", emptyDir, "--json", "--max-violations", "0"]);
      const sarif = await runVerb(["check-swift", emptyDir, "--format", "sarif", "--max-violations", "0"]);
      expect(Exit.isSuccess(text.exit)).toBe(true);
      expect(Exit.isSuccess(json.exit)).toBe(true);
      expect(Exit.isSuccess(sarif.exit)).toBe(true);
    },
  );
});
