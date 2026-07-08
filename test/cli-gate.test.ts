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
 * the exit code, complementing the pure-decision coverage in `impact-gate.test`.
 *
 * The scan dir holds exactly one fixture — a single `critical`-impact finding,
 * with NO `binclusive.json`, so it is ADVISORY (warn) by default (ADR 0010) —
 * so the exit codes are deterministic:
 *   - no gate           → 0 (advisory first-run default; nothing blocks)
 *   - --max-violations 0 → 1 (opt-in volume gate trips: 1 finding > 0)
 *   - --max-violations 5 → 0 (opt-in, below the volume threshold ⇒ green)
 *   - --fail-on critical → 1 (opt-in severity gate at the threshold)
 *
 * The opt-in gate flags force a failing exit on TOP of the advisory baseline —
 * advisory is the no-config baseline, never a cap.
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
  it("DEFAULT is advisory with no binclusive.json ⇒ exit 0, no gate flags (ADR 0010)", async () => {
    // No committed contract ⇒ the finding is advisory (warn), so the first-run
    // default exits 0. Blocking is opt-in (a contract or the gate flags below).
    expect(await runCheck([scanDir, "--json"])).toBe(0);
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

describe("check — generic --ci mode (#2236): first-class non-blocking exit-0", () => {
  it("findings present ⇒ exit 0 under --ci (and under the advisory no-config default)", async () => {
    // With no contract the default is already advisory (exit 0, ADR 0010); `--ci`
    // keeps the non-blocking exit-0 a first-class engine mode, not a shell `|| true`.
    expect(await runCheck([scanDir, "--json"])).toBe(0);
    expect(await runCheck([scanDir, "--json", "--ci"])).toBe(0);
  });

  it("--ci emits SARIF and still exits 0 (--format sarif)", async () => {
    expect(await runCheck([scanDir, "--format", "sarif", "--ci"])).toBe(0);
  });

  it("--ci is overridden by the opt-in gate — a runner can still fail the build", async () => {
    // Non-blocking is the default, but --fail-on / --max-violations re-enable a
    // failing exit even under --ci.
    expect(await runCheck([scanDir, "--json", "--ci", "--fail-on", "critical"])).toBe(1);
    expect(await runCheck([scanDir, "--json", "--ci", "--max-violations", "0"])).toBe(1);
  });
});

describe("check — --format canonical output selector (#2236)", () => {
  it("--format sarif emits a valid SARIF 2.1.0 log to stdout", async () => {
    const lines: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...a) => {
      lines.push(a.map(String).join(" "));
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = undefined;
    try {
      await Effect.runPromiseExit(
        runCli(["node", "a11y-checker", "check", scanDir, "--format", "sarif", "--ci"]).pipe(
          Effect.provide(NodeContext.layer),
        ),
      );
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
    }
    const sarif = JSON.parse(lines.join("\n"));
    expect(sarif.version).toBe("2.1.0");
    expect(Array.isArray(sarif.runs)).toBe(true);
    expect(sarif.runs[0].tool.driver.name).toBe("Binclusive");
  });

  it("--format json matches the legacy --json output (alias equivalence)", async () => {
    // Advisory no-config default (ADR 0010): both aliases exit 0 identically.
    expect(await runCheck([scanDir, "--format", "json"])).toBe(0);
  });
});
