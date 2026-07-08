/**
 * END-TO-END tracer for the URL-scan → canonical-contract seam (#2335).
 *
 * This is the behavioral proof that a rendered-URL scan actually EMITS and SENDS
 * the canonical `@binclusive/a11y-contract` `FindingPayload`. It drives the FULL
 * assembled `runCheckUrl` path — real Chromium, real axe-core, the real `enrichAll`
 * corpus cross-ref, and the real `phoneHome` seam — and asserts the wire occurrences
 * carry `location.kind: "page"` + the scanned `url`.
 *
 * WHY http, NOT file:// — `isPageFinding` (source-identity.ts) matches `^https?://`
 * ONLY. The sibling `collect-dom.e2e.test.ts` fixture is served over `file://`, which
 * `resolveLocations` would branch to the SOURCE arm — misclassifying a page finding.
 * So this test serves the same broken fixture over a real loopback HTTP server: only
 * then is the page-location arm actually exercised. (AC3.)
 *
 * The ONLY injected seam is `phoneHome`'s `fetch` (mirroring `runCheck`'s
 * `agentOverrides`): a stub that captures the POST body instead of hitting the
 * network. Everything upstream of the wire is real. (AC1 + AC2.)
 *
 * DRIVEN IN `json` MODE — since #243 brought `check-url` onto the shared `reportStack`
 * seam, phone-home fires on the machine (json) emit path exactly as the static `check
 * --json` surface does, not unconditionally in the human text report. `json` is the
 * CI/dashboard delivery mode, so this tracer drives it to exercise the send.
 *
 * GATING — `*.e2e.test.ts`, so it is EXCLUDED from the default browser-free `pnpm
 * test` (unit) run and runs only under `pnpm test:e2e` (which installs Chromium
 * first). This keeps AC4 — the unit suite stays browser-free — intact.
 */
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCheckUrl } from "../src/cli";
import { GATE_OFF } from "../src/impact-gate";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_HTML = readFileSync(join(here, "fixtures", "a11y-broken.html"), "utf8");

// Browser launch + navigation + axe run takes several seconds cold; give it room.
const E2E_TIMEOUT_MS = 60_000;

/** Serve the broken fixture over a real loopback HTTP origin so `^https?://` matches. */
function startServer(): Promise<{ server: Server; url: string }> {
  return new Promise((resolvePromise) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(FIXTURE_HTML);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("no port bound");
      resolvePromise({ server, url: `http://127.0.0.1:${address.port}/` });
    });
  });
}

/** A stub `fetch` that captures the request body and ACKs the ingest mutation. */
function capturingFetch(): { fetch: typeof fetch; body: () => string | undefined } {
  let captured: string | undefined;
  const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    captured = typeof init?.body === "string" ? init.body : undefined;
    return new Response(JSON.stringify({ data: { ingestExternalFindings: { count: 1 } } }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetch, body: () => captured };
}

describe("runCheckUrl: rendered-URL scan emits + sends the page-shaped contract (e2e, launches Chromium)", () => {
  // The gate marks a URL scan with blocking findings as exit 1; snapshot + restore
  // so driving the runner does not leak a non-zero exit code into the vitest run.
  const savedExitCode = process.exitCode;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    // Phone-home is env-gated — supply the four credentials so `resolveConfig`
    // returns `ready` and the assembled path actually reaches the (stubbed) POST.
    process.env.B8E_TOKEN = "b8e_secret_do_not_log";
    process.env.B8E_ORG_ID = "org_1";
    process.env.B8E_PROJECT_ID = "proj_1";
    process.env.B8E_AUDIT_ID = "audit_1";
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    process.exitCode = savedExitCode;
  });

  it(
    "projects a real scanUrl finding to location.kind:'page' + url and sends it via phoneHome",
    async () => {
      const { server, url } = await startServer();
      const { fetch, body } = capturingFetch();
      try {
        // json machine mode: the seam phones home on the json emit path (#243).
        await runCheckUrl(url, "json", "local", GATE_OFF, { fetch });
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
      }

      // The stub was invoked — the assembled path reached the phone-home seam.
      const raw = body();
      expect(raw).toBeDefined();
      const parsed: unknown = JSON.parse(raw as string);

      // Walk the GraphQL variables to the wire occurrences the engine projected.
      const input = (parsed as { variables?: { input?: unknown } }).variables?.input;
      const envelope = input as {
        provenance?: string;
        scannedTargets?: readonly string[];
        findings?: readonly { location?: { kind?: string; url?: string } }[];
      };

      // axe findings project to the `deterministic` provenance envelope.
      expect(envelope.provenance).toBe("deterministic");
      // The scanned page is declared as the run's scanned target (reconcile keys on url).
      expect(envelope.scannedTargets).toContain(url);

      const wireFindings = envelope.findings ?? [];
      expect(wireFindings.length).toBeGreaterThan(0);

      // AC1/AC3: EVERY wire occurrence is page-located and carries the scanned url —
      // never the source `{ path, lineHash, index }` arm a file:// fixture would mint.
      for (const f of wireFindings) {
        expect(f.location?.kind).toBe("page");
        expect(f.location?.url).toBe(url);
      }
    },
    E2E_TIMEOUT_MS,
  );
});
