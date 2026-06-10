import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The CLI dispatch + USAGE banner are driven by the flat `COMMANDS` table in
 * `cli.ts` (ADR 0002 — a plain command list, not a Collector registry). These
 * tests pin that behavior at the process boundary: every verb appears in the
 * derived USAGE, an unknown command falls through to USAGE + exit 2, a known
 * verb with a missing positional prints its own usage line, and a bare path
 * argument still routes to `check`.
 *
 * They run the real `tsx src/cli.ts` so the assertions cover the actual derived
 * banner and exit codes, not a re-implementation of the table.
 */
const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "src", "cli.ts");
const run = promisify(execFile);

/** Run the CLI with `args`; resolve to `{ stdout, stderr, code }` either way. */
async function runCli(
  args: readonly string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await run("npx", ["tsx", cli, ...args], { cwd: join(here, "..") });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: e.code ?? 1 };
  }
}

const VERBS = ["check", "check-url", "check-swift", "init", "learn", "gen", "mcp", "hook"];

describe("CLI command table: USAGE derivation", () => {
  it(
    "an unrecognized flag (no positional) prints the derived USAGE (all verbs) and exits 2",
    { timeout: 30_000 },
    async () => {
      // A bare non-verb WORD is treated as a `check <dir>` target (back-compat),
      // so use a flag — it leaves no positional, hitting the pure-USAGE branch.
      const { stderr, code } = await runCli(["--bogus"]);
      expect(code).toBe(2);
      expect(stderr.startsWith("usage:")).toBe(true);
      for (const verb of VERBS) {
        expect(stderr).toContain(`a11y-checker ${verb}`);
      }
    },
  );

  it("no arguments prints the derived USAGE and exits 2", { timeout: 30_000 }, async () => {
    const { stderr, code } = await runCli([]);
    expect(code).toBe(2);
    expect(stderr.startsWith("usage:")).toBe(true);
    expect(stderr).toContain("a11y-checker check <dir>");
  });
});

describe("CLI command table: dispatch", () => {
  it(
    "a known verb with a missing positional prints its own usage, not the banner",
    { timeout: 30_000 },
    async () => {
      const { stderr, code } = await runCli(["check"]);
      expect(code).toBe(2);
      expect(stderr).toMatch(/usage: a11y-checker check <dir> \[--json\]/);
      // The per-verb usage, NOT the full multi-line banner.
      expect(stderr.startsWith("usage:\n")).toBe(false);
    },
  );

  it(
    "a bare path argument falls through to `check` (back-compat default)",
    { timeout: 30_000 },
    async () => {
      // An empty dir scans cleanly: `check` reports the no-.tsx zero-state and
      // exits 0 — proving the bare arg routed to runCheck, not to USAGE/exit 2.
      const { stdout, code } = await runCli([emptyDir]);
      expect(code).toBe(0);
      expect(stdout).toContain(`No .tsx files under ${emptyDir}`);
    },
  );
});

let emptyDir: string;
beforeAll(async () => {
  emptyDir = await mkdtemp(join(tmpdir(), "a11y-cli-commands-"));
});
afterAll(async () => {
  await rm(emptyDir, { recursive: true, force: true });
});
