/**
 * Browser-free guard for the URL-scan failed-vs-clean distinction (#218).
 *
 * A rendered-URL scan that FAILED (navigation/render/server error) must never read
 * as a clean zero-violation pass on the human surface + exit code — the silent-green
 * the machine surfaces (--json/--sarif) already close. This drives `runCheckUrl` with
 * a MOCKED `scanUrl` (no Chromium) returning each arm of the `DomScanResult` union and
 * asserts the two are distinguishable:
 *   - failed  -> non-zero exit + a "FAILED" label surfaced, NOT "No axe-core violations"
 *   - ok/[]   -> exit 0 + "No axe-core violations found."
 *
 * `scanUrl` is mocked the same way `mcp.test.ts` mocks it; `phoneHome` is stubbed so
 * the clean-pass path touches no network. Kept as a `.test.ts` (not `.e2e.`) so it
 * runs in the default browser-free `pnpm test`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DomScanResult } from "../src/collect-dom";

// runCheckUrl loads the browser lane via a dynamic `import("./collect-dom")`; the mock
// intercepts that import so no real Chromium launches.
vi.mock("../src/collect-dom", () => ({ scanUrl: vi.fn() }));
// phoneHome runs on the clean-pass path — stub it so the test stays offline.
vi.mock("../src/phone-home", () => ({ phoneHome: vi.fn(async () => {}) }));

const { scanUrl } = await import("../src/collect-dom");
const mockScanUrl = vi.mocked(scanUrl);
const { runCheckUrl } = await import("../src/cli");

describe("runCheckUrl: a failed render is not a clean pass (#218)", () => {
  let logs: string[];
  let errs: string[];
  let savedExit: typeof process.exitCode;

  beforeEach(() => {
    logs = [];
    errs = [];
    savedExit = process.exitCode;
    process.exitCode = 0;
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void errs.push(a.join(" ")));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mockScanUrl.mockReset();
    process.exitCode = savedExit;
  });

  it("failed render -> non-zero exit + failure surfaced, never 'no violations'", async () => {
    const failed: DomScanResult = {
      url: "http://127.0.0.1:1/",
      status: "failed",
      error: "Failed to load http://127.0.0.1:1/: net::ERR_CONNECTION_REFUSED. Check the URL is reachable.",
    };
    mockScanUrl.mockResolvedValue(failed);

    await runCheckUrl("http://127.0.0.1:1/");

    expect(process.exitCode).not.toBe(0);
    const all = [...logs, ...errs].join("\n");
    // A text/label signal (not color alone) that names the failure + the error.
    expect(all).toMatch(/FAIL/i);
    expect(all).toContain("ERR_CONNECTION_REFUSED");
    // The clean-pass empty-state must NOT appear for a failed run.
    expect(all).not.toMatch(/No axe-core violations found\./);
  });

  it("clean pass (ok, zero findings) -> exit 0 + 'No axe-core violations found.'", async () => {
    const clean: DomScanResult = {
      url: "http://127.0.0.1:1/",
      status: "ok",
      findings: [],
    };
    mockScanUrl.mockResolvedValue(clean);

    await runCheckUrl("http://127.0.0.1:1/");

    expect(process.exitCode).toBe(0);
    const all = [...logs, ...errs].join("\n");
    expect(all).toMatch(/No axe-core violations found\./);
    // The clean pass is NOT a failure — no failure label.
    expect(all).not.toMatch(/scan FAILED/i);
  });
});
