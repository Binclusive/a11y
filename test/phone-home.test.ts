import { describe, expect, it, vi } from "vitest";
import { enrich, type EnrichedFinding } from "../src/corpus";
import type { Finding } from "../src/core";
import {
  assembleEnvelopes,
  type PhoneHomeConfig,
  type PhoneHomeDeps,
  phoneHome,
  resolveConfig,
  toCiFinding,
} from "../src/phone-home";

/**
 * Phone-home's ONE contract: it NEVER blocks. Every failure mode — no token, an
 * unreachable endpoint, a timeout, a 4xx/5xx, a GraphQL `errors` array, a
 * malformed body — must resolve to a value and NEVER throw, so the caller always
 * exits 0. The `failure → resolves (never rejects)` assertion IS the spec, so it
 * is exercised directly for every mode below. Two structural guarantees ride
 * alongside: the wire stays metadata-only (path, never `file:line`/source) and
 * the bearer token never appears in a log line.
 */

const raw = (over: Partial<Finding> = {}): Finding => ({
  file: "src/Button.tsx",
  line: 12,
  ruleId: "jsx-a11y/alt-text",
  message: "img is missing an alt attribute",
  wcag: ["1.1.1"],
  enforcement: "block",
  provenance: "jsx-a11y",
  ...over,
});

const finding = (over: Partial<Finding> = {}): EnrichedFinding => enrich(raw(over));

const FULL_ENV: NodeJS.ProcessEnv = {
  B8E_TOKEN: "b8e_secret_do_not_log",
  B8E_ORG_ID: "org_1",
  B8E_PROJECT_ID: "proj_1",
  B8E_AUDIT_ID: "audit_1",
  B8E_INGEST_URL: "https://kontrol.test/graphql",
};

const CONFIG: PhoneHomeConfig = {
  endpoint: "https://kontrol.test/graphql",
  token: "b8e_secret_do_not_log",
  orgID: "org_1",
  projectID: "proj_1",
  auditID: "audit_1",
  scope: "ci-diff",
  timeoutMs: 10_000,
};

/** A deps stub whose `fetch` and `scanTargets` are controllable per test. */
function deps(over: Partial<PhoneHomeDeps> & { fetch: PhoneHomeDeps["fetch"] }): {
  deps: PhoneHomeDeps;
  logs: string[];
} {
  const logs: string[] = [];
  return {
    logs,
    deps: {
      fetch: over.fetch,
      now: over.now ?? (() => new Date("2026-07-04T00:00:00.000Z")),
      log: over.log ?? ((m) => logs.push(m)),
      scanTargets: over.scanTargets ?? (() => ["src/Button.tsx"]),
    },
  };
}

const ok = (count: number): typeof fetch =>
  vi.fn(async () => new Response(JSON.stringify({ data: { ingestExternalFindings: { count } } }), { status: 200 })) as unknown as typeof fetch;

// ── Absence is opt-out, not error ──

describe("skip: absent credentials are a non-error opt-out", () => {
  it("no token → skipped(no-token), no fetch attempted", async () => {
    const fetchSpy = vi.fn();
    const { deps: d } = deps({ fetch: fetchSpy as unknown as typeof fetch });
    const outcome = await phoneHome([finding()], "src", {}, d);
    expect(outcome).toEqual({ status: "skipped", reason: "no-token" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["no-org", { B8E_TOKEN: "b8e_x" }],
    ["no-project", { B8E_TOKEN: "b8e_x", B8E_ORG_ID: "o" }],
    ["no-audit", { B8E_TOKEN: "b8e_x", B8E_ORG_ID: "o", B8E_PROJECT_ID: "p" }],
  ])("missing id → skipped(%s)", async (reason, env) => {
    const { deps: d } = deps({ fetch: ok(1) });
    const outcome = await phoneHome([finding()], "src", env, d);
    expect(outcome).toEqual({ status: "skipped", reason });
  });

  it("no findings → skipped(no-findings) (schema forbids an empty batch)", async () => {
    const fetchSpy = vi.fn();
    const { deps: d } = deps({ fetch: fetchSpy as unknown as typeof fetch });
    const outcome = await phoneHome([], "src", FULL_ENV, d);
    expect(outcome).toEqual({ status: "skipped", reason: "no-findings" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ── The load-bearing spec: every failure resolves, never throws, never blocks ──

describe("never blocks: every failure mode resolves to a value", () => {
  it("network error (fetch rejects) → resolves to failed(network), never rejects", async () => {
    const { deps: d } = deps({ fetch: vi.fn(async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch });
    // `.resolves` (not `.rejects`) is the load-bearing assertion: a throw inside
    // fetch must surface as a value, never propagate out and fail the run.
    const settled = await expect(phoneHome([finding()], "src", FULL_ENV, d)).resolves.toMatchObject({
      status: "failed",
      reason: { kind: "network" },
    });
    void settled;
  });

  it("timeout (AbortError) → failed(timeout)", async () => {
    const abort = () => {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    };
    const { deps: d } = deps({ fetch: vi.fn(async () => abort()) as unknown as typeof fetch });
    const settled = await phoneHome([finding()], "src", FULL_ENV, d);
    expect(settled).toEqual({ status: "failed", reason: { kind: "timeout" } });
  });

  it.each([400, 401, 403, 429, 500, 503])("HTTP %d → failed(http, status)", async (status) => {
    const { deps: d } = deps({ fetch: vi.fn(async () => new Response("no", { status })) as unknown as typeof fetch });
    const settled = await phoneHome([finding()], "src", FULL_ENV, d);
    expect(settled).toEqual({ status: "failed", reason: { kind: "http", status } });
  });

  it("GraphQL errors array → failed(graphql-errors)", async () => {
    const body = JSON.stringify({ errors: [{ message: "boom" }, { message: "bad" }] });
    const { deps: d } = deps({ fetch: vi.fn(async () => new Response(body, { status: 200 })) as unknown as typeof fetch });
    const settled = await phoneHome([finding()], "src", FULL_ENV, d);
    expect(settled).toEqual({ status: "failed", reason: { kind: "graphql-errors", count: 2 } });
  });

  it("malformed body (not JSON) → failed(malformed-response)", async () => {
    const { deps: d } = deps({ fetch: vi.fn(async () => new Response("<html>502</html>", { status: 200 })) as unknown as typeof fetch });
    const settled = await phoneHome([finding()], "src", FULL_ENV, d);
    expect(settled).toEqual({ status: "failed", reason: { kind: "malformed-response" } });
  });

  it("well-formed JSON missing the payload → failed(malformed-response)", async () => {
    const { deps: d } = deps({ fetch: vi.fn(async () => new Response(JSON.stringify({ data: {} }), { status: 200 })) as unknown as typeof fetch });
    const settled = await phoneHome([finding()], "src", FULL_ENV, d);
    expect(settled).toEqual({ status: "failed", reason: { kind: "malformed-response" } });
  });
});

// ── Success + partial ──

describe("send: accepted envelopes report sent", () => {
  it("all-deterministic run → one envelope, sent with the ingested count", async () => {
    const fetchSpy = ok(3);
    const { deps: d } = deps({ fetch: fetchSpy });
    const outcome = await phoneHome([finding(), finding({ ruleId: "x" })], "src", FULL_ENV, d);
    expect(outcome).toEqual({ status: "sent", envelopes: 1, ingested: 3 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("mixed provenance → two envelopes (deterministic + agent)", async () => {
    let calls = 0;
    const fetchSpy = vi.fn(async () => {
      calls += 1;
      return new Response(JSON.stringify({ data: { ingestExternalFindings: { count: 1 } } }), { status: 200 });
    }) as unknown as typeof fetch;
    const { deps: d } = deps({ fetch: fetchSpy });
    const outcome = await phoneHome(
      [finding(), finding({ provenance: "corpus-agent", file: "https://x", line: 0, selector: "div" })],
      "src",
      FULL_ENV,
      d,
    );
    expect(outcome).toEqual({ status: "sent", envelopes: 2, ingested: 2 });
    expect(calls).toBe(2);
  });

  it("partial: one envelope fails, the other lands → still sent (forward progress)", async () => {
    let n = 0;
    const fetchSpy = vi.fn(async () => {
      n += 1;
      return n === 1 ? new Response("err", { status: 500 }) : new Response(JSON.stringify({ data: { ingestExternalFindings: { count: 1 } } }), { status: 200 });
    }) as unknown as typeof fetch;
    const { deps: d } = deps({ fetch: fetchSpy });
    const outcome = await phoneHome(
      [finding(), finding({ provenance: "corpus-agent", file: "https://x", line: 0, selector: "div" })],
      "src",
      FULL_ENV,
      d,
    );
    expect(outcome).toEqual({ status: "sent", envelopes: 1, ingested: 1 });
  });
});

// ── Secrets never log ──

describe("secrets never appear in logs", () => {
  it("no log line contains the bearer token across success and failure", async () => {
    const modes: Array<typeof fetch> = [
      ok(1),
      vi.fn(async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch,
      vi.fn(async () => new Response("x", { status: 500 })) as unknown as typeof fetch,
    ];
    for (const f of modes) {
      const { deps: d, logs } = deps({ fetch: f });
      await phoneHome([finding()], "src", FULL_ENV, d);
      for (const line of logs) expect(line).not.toContain("b8e_secret_do_not_log");
    }
  });
});

// ── Metadata-only wire + reconcile keying (#2166) ──

describe("wire is metadata-only and reconcile-keyed", () => {
  it("toCiFinding keeps the path as url but drops file:line/source", () => {
    const ci = toCiFinding(finding({ file: "/root/src/Button.tsx", line: 12 }), "/root", "2026-07-04T00:00:00.000Z");
    expect(ci.url).toBe("src/Button.tsx");
    expect(JSON.stringify(ci)).not.toContain("12"); // no source line on the wire
    expect(JSON.stringify(ci)).not.toContain("line");
    expect(ci).not.toHaveProperty("snippet");
    expect(ci).not.toHaveProperty("source");
  });

  it("finding.url ∈ scannedTargets: the run stamps both from the same path vocabulary (#2166)", () => {
    const scanned = ["src/Button.tsx", "src/Nav.tsx"];
    const envelopes = assembleEnvelopes([finding({ file: "/root/src/Button.tsx" })], "/root", CONFIG, scanned, "2026-07-04T00:00:00.000Z");
    expect(envelopes).toHaveLength(1);
    const [env] = envelopes;
    expect(env.scannedTargets).toEqual(scanned);
    // Reconcile keys on ticket.url ∈ scannedTargets — so an emitted finding's url
    // MUST be drawn from the scannedTargets vocabulary. Prove the intersection.
    for (const f of env.findings) expect(scanned).toContain(f.url);
  });

  it("scannedTargets is sourced from the injected diff-scope seam", async () => {
    const scanTargets = vi.fn(() => ["src/A.tsx", "src/B.tsx"]);
    let captured: unknown;
    const fetchSpy = vi.fn(async (_url: unknown, init: { body: string }) => {
      captured = JSON.parse(init.body);
      return new Response(JSON.stringify({ data: { ingestExternalFindings: { count: 1 } } }), { status: 200 });
    }) as unknown as typeof fetch;
    const { deps: d } = deps({ fetch: fetchSpy, scanTargets });
    await phoneHome([finding()], "src", FULL_ENV, d);
    expect(scanTargets).toHaveBeenCalled();
    expect((captured as { variables: { input: { scannedTargets: string[] } } }).variables.input.scannedTargets).toEqual(["src/A.tsx", "src/B.tsx"]);
  });
});

// ── Config resolution ──

describe("resolveConfig", () => {
  it("defaults the endpoint to production Kontrol when unset", () => {
    const r = resolveConfig({ B8E_TOKEN: "b8e_x", B8E_ORG_ID: "o", B8E_PROJECT_ID: "p", B8E_AUDIT_ID: "a" });
    expect(r).toMatchObject({ kind: "ready", config: { endpoint: "https://kontrol.binclusive.io/graphql" } });
  });

  it("falls back auditID to GITHUB_RUN_ID when B8E_AUDIT_ID is unset", () => {
    const r = resolveConfig({ B8E_TOKEN: "b8e_x", B8E_ORG_ID: "o", B8E_PROJECT_ID: "p", GITHUB_RUN_ID: "run_42" });
    expect(r).toMatchObject({ kind: "ready", config: { auditID: "run_42" } });
  });

  it("treats whitespace-only credentials as absent", () => {
    expect(resolveConfig({ B8E_TOKEN: "   " })).toEqual({ kind: "skip", reason: "no-token" });
  });
});
