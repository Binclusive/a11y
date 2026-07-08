/**
 * Browser-free guard that `check-url` is on the unified output-format + gate seam
 * (#243/#176): it mounts the SAME `gateOptions` and threads the SAME
 * `resolveFormat` + `resolveGate` as every other `check*` command, so
 * `--format text|json|sarif` (+ `--json`/`--sarif` aliases), `--ci`, `--fail-on`
 * and `--max-violations` are all accepted and behave IDENTICALLY to the static path.
 *
 * The rendered-DOM surface can't run a real browser in the default unit tier, so
 * `scanUrl` is MOCKED (the same way `cli-url-fail.test.ts` / `mcp.test.ts` mock it)
 * to return crafted axe findings; `phoneHome` is stubbed so the json path touches no
 * network. Findings carry `file` = an `http://` URL so `resolveLocations` routes them
 * through the page-shaped arm the way a real rendered scan would.
 *
 * Kept as a `.test.ts` (not `.e2e.`) so it runs in the default browser-free `pnpm test`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NodeContext } from "@effect/platform-node";
import { Effect } from "effect";
import type { DomScanResult } from "../src/collect-dom";
import type { Finding } from "../src/core";

// runCheckUrl loads the browser lane via a dynamic `import("./collect-dom")`; the mock
// intercepts that import so no real Chromium launches.
vi.mock("../src/collect-dom", () => ({ scanUrl: vi.fn() }));
// phoneHome runs on the json emit path — stub it so the test stays offline.
vi.mock("../src/phone-home", () => ({ phoneHome: vi.fn(async () => {}) }));

const { scanUrl } = await import("../src/collect-dom");
const mockScanUrl = vi.mocked(scanUrl);
const { runCli } = await import("../src/cli");

const URL = "http://127.0.0.1:1/";

/**
 * A crafted axe finding on a page (`file` = the scanned URL, `line` 0). `ruleId` is
 * deliberately absent from the baseline catalog so `evidenceImpact` falls back to the
 * finding's own `impact` — giving the gate cases a deterministic severity to reason on.
 */
function pageFinding(over: Partial<Finding>): Finding {
  return {
    file: URL,
    line: 0,
    ruleId: "x-test-rule",
    message: "test finding",
    wcag: [],
    enforcement: "block",
    provenance: "axe",
    selector: "img",
    impact: "critical",
    helpUrl: "https://example.test/help",
    ...over,
  };
}

/** Drive `check-url <URL> ...flags` through the real CLI; capture stdout + exit code. */
async function runUrl(flags: readonly string[]): Promise<{ exit: number; stdout: string }> {
  const out: string[] = [];
  const logSpy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
  const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  process.exitCode = undefined;
  try {
    await Effect.runPromiseExit(
      runCli(["node", "a11y-checker", "check-url", URL, ...flags]).pipe(Effect.provide(NodeContext.layer)),
    );
    return { exit: process.exitCode ?? 0, stdout: out.join("\n") };
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
  }
}

describe("check-url on the unified output-format + gate seam (#243)", () => {
  const savedExit = process.exitCode;

  beforeEach(() => {
    process.exitCode = undefined;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    mockScanUrl.mockReset();
    process.exitCode = savedExit;
  });

  it("--format sarif emits valid SARIF for the rendered-DOM findings (page-located)", async () => {
    mockScanUrl.mockResolvedValue({ url: URL, status: "ok", findings: [pageFinding({})] });

    const { stdout } = await runUrl(["--format", "sarif"]);
    const doc = JSON.parse(stdout) as {
      $schema?: string;
      version?: string;
      runs?: { results?: unknown[] }[];
    };

    expect(doc.version).toBe("2.1.0");
    expect(doc.$schema).toMatch(/sarif/i);
    expect(doc.runs?.[0]?.results?.length).toBeGreaterThan(0);
    // The finding is page-located: the scanned URL rides the SARIF artifact.
    expect(stdout).toContain(URL);
  });

  it("--format json emits the machine JSON report for the rendered-DOM findings", async () => {
    mockScanUrl.mockResolvedValue({ url: URL, status: "ok", findings: [pageFinding({})] });

    const { stdout } = await runUrl(["--format", "json"]);
    const report = JSON.parse(stdout) as {
      tool?: string;
      findings?: { ruleId?: string; impact?: string; enforcement?: string }[];
    };

    expect(report.tool).toBe("a11y-checker");
    expect(report.findings?.length).toBe(1);
    expect(report.findings?.[0]?.ruleId).toBe("x-test-rule");
    expect(report.findings?.[0]?.impact).toBe("critical");
  });

  it("--ci is a first-class NON-BLOCKING run: exit 0 even with a blocking finding", async () => {
    mockScanUrl.mockResolvedValue({ url: URL, status: "ok", findings: [pageFinding({ enforcement: "block" })] });

    // Without --ci this blocking finding exits 1 (asserted below); --ci makes it advisory.
    expect((await runUrl([])).exit).toBe(1);
    expect((await runUrl(["--ci"])).exit).toBe(0);
  });

  it("--fail-on trips the opt-in severity gate: exit 1 at/above threshold, exit 0 below", async () => {
    mockScanUrl.mockResolvedValue({
      url: URL,
      status: "ok",
      findings: [pageFinding({ enforcement: "warn", impact: "critical" })],
    });
    // A warn-only finding is advisory by default, but --fail-on critical trips on its impact.
    expect((await runUrl(["--fail-on", "critical"])).exit).toBe(1);

    mockScanUrl.mockResolvedValue({
      url: URL,
      status: "ok",
      findings: [pageFinding({ enforcement: "warn", impact: "minor" })],
    });
    // A minor finding is below the critical threshold ⇒ the gate stays green.
    expect((await runUrl(["--fail-on", "critical"])).exit).toBe(0);
  });

  it("advisory default (ADR 0010): a warn-only finding, no gate flags ⇒ exit 0", async () => {
    mockScanUrl.mockResolvedValue({
      url: URL,
      status: "ok",
      findings: [pageFinding({ enforcement: "warn", impact: "serious" })],
    });
    // No `binclusive.json` ⇒ every finding is `warn`; the rendered-DOM surface is no
    // longer unconditionally blocking — a warn-only scan is a clean build.
    expect((await runUrl([])).exit).toBe(0);
  });

  it("the exit code is format-INDEPENDENT: a blocking finding exits 1 across text / --json / --sarif", async () => {
    mockScanUrl.mockResolvedValue({ url: URL, status: "ok", findings: [pageFinding({ enforcement: "block" })] });

    const text = (await runUrl([])).exit;
    mockScanUrl.mockResolvedValue({ url: URL, status: "ok", findings: [pageFinding({ enforcement: "block" })] });
    const json = (await runUrl(["--json"])).exit;
    mockScanUrl.mockResolvedValue({ url: URL, status: "ok", findings: [pageFinding({ enforcement: "block" })] });
    const sarif = (await runUrl(["--format", "sarif"])).exit;

    expect([text, json, sarif]).toEqual([1, 1, 1]);
  });
});
