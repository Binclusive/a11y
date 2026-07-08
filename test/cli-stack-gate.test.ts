import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeContext } from "@effect/platform-node";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli";

/**
 * The #176 regression guard: every deterministic stack-scan command
 * (`check-shopify` / `check-unity` / `check-android`) gates EXACTLY like the
 * default `check` — ONE gate, ONE exit-code rule, INDEPENDENT of output format.
 *
 * The bug this pins: `check-shopify` used to exit 0 on the `--json` / `--sarif`
 * branch (a hard-coded advisory gate) while the text branch exited 1 on the same
 * block-level findings. The unified runners now thread the SAME `GateConfig`
 * through both the machine-emit path and the human report, so the exit is
 * format-agnostic and honors `--ci` / `--fail-on` / `--max-violations` everywhere.
 *
 * Each fixture project carries NO `binclusive.json`, so `enforcementFor` returns
 * the ADVISORY "warn" disposition for every finding (first-run default, ADR
 * 0010) — the default scan exits 0. The #176 invariant under test is
 * format-INDEPENDENCE (the exit is the same across text / --json / --sarif),
 * which the opt-in gate cases below exercise on a genuinely-failing exit
 * (`--max-violations 0` ⇒ [1, 1, 1] identically); the default case here proves
 * the advisory exit is likewise format-independent.
 *
 * In-process only (no browser, no toolchain) — `check-swift` spawns the real Swift
 * engine and lives in the slow `cli-swift.e2e.test.ts` tier; its exit-code parity
 * rides the SAME shared `reportStack` path proven here on three stacks.
 */

const here = dirname(fileURLToPath(import.meta.url));

const STACKS = [
  { verb: "check-shopify", fixture: join(here, "fixtures", "liquid-theme") },
  { verb: "check-unity", fixture: join(here, "fixtures", "unity-project") },
  { verb: "check-android", fixture: join(here, "fixtures", "android-xml") },
] as const;

// The three output selectors under test — text (no flag), the `--json` alias, and
// the canonical `--format sarif`. The exit code MUST NOT depend on which is used.
const FORMAT_FLAGS: readonly (readonly string[])[] = [[], ["--json"], ["--format", "sarif"]];

/** Drive one verb over `dir` with `extra` flags; return the resulting exit code. */
async function exitFor(verb: string, dir: string, extra: readonly string[]): Promise<number> {
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  process.exitCode = undefined;
  try {
    await Effect.runPromiseExit(
      runCli(["node", "a11y-checker", verb, dir, ...extra]).pipe(Effect.provide(NodeContext.layer)),
    );
    return process.exitCode ?? 0;
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
  }
}

/** The exit codes for the same scan across text / --json / --sarif. */
async function exitsAcrossFormats(
  verb: string,
  dir: string,
  gateFlags: readonly string[],
): Promise<number[]> {
  const exits: number[] = [];
  for (const format of FORMAT_FLAGS) {
    exits.push(await exitFor(verb, dir, [...format, ...gateFlags]));
  }
  return exits;
}

beforeEach(() => {
  process.exitCode = undefined;
});

describe.each(STACKS)("$verb — format-independent gate (#176)", ({ verb, fixture }) => {
  it(
    "no-config default is advisory ⇒ exits 0 identically across text / --json / --sarif (ADR 0010)",
    { timeout: 30_000 },
    async () => {
      // No `binclusive.json` ⇒ every finding is advisory (warn), so the default gate
      // exits 0 — the SAME for all three formats (format-independence, #176; the old
      // advisory-on-json split is gone). A genuinely-failing format-independent exit
      // is proven by the `--max-violations 0` case below ([1, 1, 1]).
      expect(await exitsAcrossFormats(verb, fixture, [])).toEqual([0, 0, 0]);
    },
  );

  it(
    "--ci is a first-class non-blocking exit-0 across every format",
    { timeout: 30_000 },
    async () => {
      expect(await exitsAcrossFormats(verb, fixture, ["--ci"])).toEqual([0, 0, 0]);
    },
  );

  it(
    "--max-violations 0 trips the opt-in volume gate across every format",
    { timeout: 30_000 },
    async () => {
      // The fixtures all surface at least one finding, so 1 > 0 trips the gate.
      expect(await exitsAcrossFormats(verb, fixture, ["--max-violations", "0"])).toEqual([1, 1, 1]);
    },
  );

  it(
    "--max-violations below the finding count is green — the opt-in gate replaces the default block exit",
    { timeout: 30_000 },
    async () => {
      // A generous threshold: the opt-in gate decides the exit, so an under-threshold
      // scan is green (and the advisory-default baseline is green regardless).
      expect(await exitsAcrossFormats(verb, fixture, ["--max-violations", "1000"])).toEqual([
        0, 0, 0,
      ]);
    },
  );

  it(
    "--fail-on decides the exit identically regardless of output format",
    { timeout: 30_000 },
    async () => {
      // Value-agnostic: whatever the severity gate decides for these findings, it
      // must decide the SAME for text, --json and --sarif — the core #176 invariant.
      const exits = await exitsAcrossFormats(verb, fixture, ["--fail-on", "critical"]);
      expect(new Set(exits).size).toBe(1);
    },
  );
});
