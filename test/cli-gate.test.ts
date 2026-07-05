import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeContext } from "@effect/platform-node";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli";

/**
 * End-to-end wiring of the opt-in blocking gate (#2134) through the REAL `check`
 * command: these prove `--fail-on` / `--max-violations` parse and thread down to
 * the exit code, complementing the pure-decision coverage in `severity-gate.test`.
 *
 * The scan dir holds exactly one fixture — a single `critical` / `block`
 * finding — so the exit codes are deterministic:
 *   - no gate           → 1 (the historical block-gated exit, preserved)
 *   - --max-violations 0 → 1 (opt-in volume gate trips: 1 finding > 0)
 *   - --max-violations 5 → 0 (opt-in, below the volume threshold ⇒ green)
 *   - --fail-on critical → 1 (opt-in severity gate at the threshold)
 */

const here = dirname(fileURLToPath(import.meta.url));

async function runCheck(args: readonly string[]): Promise<number | undefined> {
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  process.exitCode = undefined;
  try {
    await Effect.runPromiseExit(
      runCli(["node", "a11y-checker", "check", ...args]).pipe(Effect.provide(NodeContext.layer)),
    );
    return process.exitCode;
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
  }
}

let scanDir: string;
beforeAll(async () => {
  scanDir = await mkdtemp(join(tmpdir(), "a11y-gate-"));
  await cp(join(here, "fixtures", "aria-hidden.tsx"), join(scanDir, "aria-hidden.tsx"));
});
afterAll(async () => {
  process.exitCode = undefined;
  await rm(scanDir, { recursive: true, force: true });
});

describe("check — opt-in blocking gate wiring", () => {
  it("DEFAULT OFF is unchanged: the block-gated exit is preserved (no gate flags)", async () => {
    // The fixture's finding is enforcement=block, so today's default still exits 1.
    // The gate adds NO severity-based exit when unset — this is the historical path.
    expect(await runCheck([scanDir, "--json"])).toBe(1);
  });

  it("--max-violations 0 opts in: a present finding trips the volume gate ⇒ non-zero", async () => {
    expect(await runCheck([scanDir, "--json", "--max-violations", "0"])).toBe(1);
  });

  it("--max-violations 5 opts in but stays below threshold ⇒ green (gate replaces default exit)", async () => {
    expect(await runCheck([scanDir, "--json", "--max-violations", "5"])).toBe(0);
  });

  it("--fail-on critical opts in: a critical finding at the threshold ⇒ non-zero", async () => {
    expect(await runCheck([scanDir, "--json", "--fail-on", "critical"])).toBe(1);
  });
});
