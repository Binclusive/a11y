import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { NodeContext } from "@effect/platform-node";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli";
import { VERSION } from "../src/version";

/**
 * The version reported by `--version` and the MCP handshake must ALWAYS equal
 * what npm publishes. Both derive from `src/version.ts`, which reads
 * package.json — so there is no literal to drift (issue #175). This test pins
 * that the derivation resolves to package.json's `version` and that the CLI
 * reports it, so a future refactor can't reintroduce a hardcoded string.
 */
const packageVersion: string = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
).version;

describe("version single-source (issue #175)", () => {
  it("VERSION equals package.json's version — the single source of truth", () => {
    expect(VERSION).toBe(packageVersion);
  });

  it("`--version` reports package.json's version, not a hardcoded literal", async () => {
    const out: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...a) => {
      out.push(a.join(" "));
    });
    try {
      await Effect.runPromiseExit(
        runCli(["node", "a11y-checker", "--version"]).pipe(Effect.provide(NodeContext.layer)),
      );
    } finally {
      logSpy.mockRestore();
    }
    expect(out.join("\n")).toContain(packageVersion);
  });
});
