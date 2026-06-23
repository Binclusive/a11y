import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeContext } from "@effect/platform-node";
import { Effect, Exit } from "effect";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli";

/**
 * The CLI dispatch is now an `@effect/cli` command tree (issue #7): a root
 * `a11y-checker` command with eight subcommands, each parsing its own
 * `Options`/`Args` and calling the matching runner. These tests pin that
 * dispatch WITHOUT spawning a process — they drive the exported `runCli`
 * (`Command.run` of the root) with a synthetic argv and the Node platform
 * context, exactly as the canon's "Running a command in a test (no process)"
 * recipe prescribes (`.patterns/effect-cli/running.md`).
 *
 * Each assertion proves a subcommand PARSED its flags/args and INVOKED its
 * runner, via the runner's observable side effects (stdout + `process.exitCode`)
 * — the report-output guarantee itself stays covered by `cli-json.test.ts` and
 * the per-collector suites. The old hand-rolled USAGE banner / arg-parse error
 * strings are gone on purpose: `@effect/cli` owns help + parse errors now.
 */

/**
 * Run the root command with `args` (the verb + its flags), capturing stdout.
 * The first two argv slots stand in for `node` + the script path, which
 * `Command.run` strips. Returns the captured stdout/stderr, the resulting
 * `process.exitCode`, and the run `Exit` so callers can assert success/failure.
 */
async function runVerb(args: readonly string[]): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number | undefined;
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
    return { stdout: out.join("\n"), stderr: err.join("\n"), exitCode: process.exitCode, exit };
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
  }
}

let emptyDir: string;
beforeAll(async () => {
  emptyDir = await mkdtemp(join(tmpdir(), "a11y-cli-commands-"));
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

describe("@effect/cli dispatch: each subcommand parses + invokes its runner", () => {
  it("`check <dir>` routes to runCheck (positional dir parsed)", { timeout: 30_000 }, async () => {
    const { stdout, exit, exitCode } = await runVerb(["check", emptyDir]);
    expect(Exit.isSuccess(exit)).toBe(true);
    // The empty-dir zero-state proves runCheck ran on the parsed dir and exited clean.
    expect(stdout).toContain(`No .tsx files under ${emptyDir}`);
    expect(exitCode ?? 0).toBe(0);
  });

  it(
    "`check <dir> --json` parses the boolean flag and emits the machine report",
    { timeout: 30_000 },
    async () => {
      const { stdout, exit } = await runVerb(["check", emptyDir, "--json"]);
      expect(Exit.isSuccess(exit)).toBe(true);
      const report = JSON.parse(stdout);
      expect(report.tool).toBe("a11y-checker");
      expect(report.findings).toEqual([]);
      expect(report.summary.findings).toBe(0);
    },
  );

  it("`check-swift <dir>` routes to runCheckSwift", { timeout: 30_000 }, async () => {
    // An empty dir has no .swift files: scanSwift returns zero findings, the
    // runner prints its empty-state and exits clean — proving the verb dispatched.
    const { stdout, exit } = await runVerb(["check-swift", emptyDir]);
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(stdout).toContain("No SwiftUI a11y violations found.");
  });

  it("`check-shopify <dir>` routes to runCheckShopify", { timeout: 30_000 }, async () => {
    // An empty dir has no .liquid files: scanLiquid returns zero findings, the
    // runner prints its empty-state and exits clean — proving the verb dispatched.
    const { stdout, exit } = await runVerb(["check-shopify", emptyDir]);
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(stdout).toContain(`No .liquid files under ${emptyDir}`);
  });

  it(
    "`check-shopify <dir> --json` parses the boolean flag and emits the machine report",
    { timeout: 30_000 },
    async () => {
      const { stdout, exit } = await runVerb(["check-shopify", emptyDir, "--json"]);
      expect(Exit.isSuccess(exit)).toBe(true);
      const report = JSON.parse(stdout);
      expect(report.tool).toBe("a11y-checker");
      expect(report.findings).toEqual([]);
      expect(report.coverage.total).toBe(0);
    },
  );

  it(
    "`init <dir>` then `gen <dir>` route to runInit / runGen (optional dir parsed)",
    { timeout: 30_000 },
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "a11y-cli-initgen-"));
      try {
        const init = await runVerb(["init", dir]);
        expect(Exit.isSuccess(init.exit)).toBe(true);
        expect(init.stdout).toContain(`a11y-checker init — ${dir}`);
        // gen needs the binclusive.json init just wrote — proves both verbs dispatched.
        const gen = await runVerb(["gen", dir]);
        expect(Exit.isSuccess(gen.exit)).toBe(true);
        expect(gen.stdout).toContain(`a11y-checker gen — ${dir}`);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  it(
    "`init --suggest <dir>` parses the boolean flag (title reflects --suggest)",
    { timeout: 30_000 },
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "a11y-cli-suggest-"));
      try {
        const { stdout, exit } = await runVerb(["init", "--suggest", dir]);
        expect(Exit.isSuccess(exit)).toBe(true);
        expect(stdout).toContain(`a11y-checker init --suggest — ${dir}`);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  it(
    "`learn` parses positional rule + --wcag comma list into the contract",
    { timeout: 30_000 },
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "a11y-cli-learn-"));
      try {
        await runVerb(["init", dir]);
        const { stdout, exit } = await runVerb([
          "learn",
          "buttons need an accessible name",
          "--wcag",
          "4.1.2,2.4.4",
          dir,
        ]);
        expect(Exit.isSuccess(exit)).toBe(true);
        // The runner echoes the learned/known rule id — proves rule + dir parsed.
        expect(stdout).toMatch(/learned ".+"|already known \(no-op\): ".+"/);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  it(
    "an unknown subcommand fails the run (effect/cli ValidationError), not a runner call",
    { timeout: 30_000 },
    async () => {
      const { exit } = await runVerb(["not-a-verb"]);
      // @effect/cli rejects an unrecognized subcommand: the run Effect fails.
      expect(Exit.isFailure(exit)).toBe(true);
    },
  );

  it(
    "a bare dir (no subcommand) falls through to `check` — back-compat shortcut",
    { timeout: 30_000 },
    async () => {
      // `origin/main`'s main() routed a bare `a11y-checker <dir>` to runCheck; the
      // subcommand tree restores it via the ROOT command's optional positional dir.
      // An empty dir scans clean — the no-.tsx zero-state proves the bare arg
      // routed to runCheck (not an "Invalid subcommand" failure), exiting 0.
      const { stdout, exit, exitCode } = await runVerb([emptyDir]);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(stdout).toContain(`No .tsx files under ${emptyDir}`);
      expect(exitCode ?? 0).toBe(0);
    },
  );
});
