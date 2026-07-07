import { describe, expect, it, vi } from "vitest";
import { enrich, type EnrichedFinding } from "../src/evidence";
import type { Finding } from "../src/core";
import {
  assembleEnvelopes,
  type PhoneHomeConfig,
  type PhoneHomeDeps,
  phoneHome,
  resolveConfig,
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
      analyzedFiles: over.analyzedFiles ?? (() => []),
      deletedPaths: over.deletedPaths ?? (() => []),
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

// ── Metadata-only wire + the source-location vertical slice (#2252-B, ADR 0042) ──

/** POST body shape the engine sends to Kontrol's `ingestExternalFindings`. */
type WireLocation =
  | { kind: "page"; url: string }
  | { kind: "source"; path: string; lineHash: string; index: number };
interface WireVars {
  variables: {
    input: {
      scannedTargets: string[];
      findings: Array<{ location: WireLocation } & Record<string, unknown>>;
    };
  };
}

/** Drive one finding all the way through phone-home and capture the POST body. */
async function capturePost(f: EnrichedFinding, root: string): Promise<WireVars> {
  let captured: WireVars | undefined;
  const fetchSpy = vi.fn(async (_url: unknown, init: { body: string }) => {
    captured = JSON.parse(init.body) as WireVars;
    return new Response(JSON.stringify({ data: { ingestExternalFindings: { count: 1 } } }), { status: 200 });
  }) as unknown as typeof fetch;
  const { deps: d } = deps({ fetch: fetchSpy });
  await phoneHome([f], root, FULL_ENV, d);
  if (captured === undefined) throw new Error("no POST captured");
  return captured;
}

describe("wire is metadata-only and location-keyed", () => {
  // THE tracer test: a source finding leaves phone-home as a Source location arm —
  // `{kind:"source", path, lineHash, index}`, NOT `{url: <path>}` and NOT a page. This
  // is the send half of the finding-identity slice (#2252-B) — the compute half (#153)
  // is inert unless this proves the engine actually PUTS the Source arm on the wire.
  it("source finding → POST carries location {kind:source,...}, never url=path / not a page", async () => {
    const wire = await capturePost(finding({ file: "/root/src/Button.tsx", line: 12 }), "/root");
    const [occ] = wire.variables.input.findings;
    expect(occ.location.kind).toBe("source");
    if (occ.location.kind !== "source") throw new Error("expected a source location");
    expect(occ.location.path).toBe("src/Button.tsx");
    expect(typeof occ.location.lineHash).toBe("string");
    expect(occ.location.index).toBe(0);
    // The moat: NO url arm on a source finding — it must not fake a page.
    expect(occ).not.toHaveProperty("url");
    expect(occ.location).not.toHaveProperty("url");
    // No `file:line` / raw content crosses: neither the line number nor a `line`/`file` key.
    const body = JSON.stringify(occ);
    expect(body).not.toContain('"line"');
    expect(body).not.toContain('"file"');
    expect(body).not.toContain('"snippet"');
    expect(body).not.toContain('"12"');
  });

  it("page finding → POST carries location {kind:page,url} (rendered-DOM occurrence)", async () => {
    const wire = await capturePost(finding({ file: "https://example.com/pricing", line: 0, selector: "button" }), "/root");
    const [occ] = wire.variables.input.findings;
    expect(occ.location).toEqual({ kind: "page", url: "https://example.com/pricing" });
  });

  it("normalizes source path separators to `/` on the wire (#2180 — Windows edge)", async () => {
    const wire = await capturePost(finding({ file: "/root/src\\a11y\\Button.tsx" }), "/root");
    const [occ] = wire.variables.input.findings;
    if (occ.location.kind !== "source") throw new Error("expected a source location");
    expect(occ.location.path).toBe("src/a11y/Button.tsx");
    expect(occ.location.path).not.toContain("\\");
  });

  it("source path ∈ scannedTargets: run stamps both from the same path vocabulary (#2166)", () => {
    const scanned = ["src/Button.tsx", "src/Nav.tsx"];
    const envelopes = assembleEnvelopes([finding({ file: "/root/src/Button.tsx" })], "/root", CONFIG, scanned, [], [], "2026-07-04T00:00:00.000Z");
    expect(envelopes).toHaveLength(1);
    const [env] = envelopes;
    expect(env.scannedTargets).toEqual(scanned);
    // Reconcile keys on the finding's path ∈ scannedTargets — so an emitted source
    // finding's path MUST be drawn from the scannedTargets vocabulary. Prove it.
    for (const { contract } of env.findings) {
      if (contract.location.kind !== "source") throw new Error("expected a source location");
      expect(scanned).toContain(contract.location.path);
    }
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

// ── The `impact` transport extra carries the 4-level axe value, not the 3-level band (#153) ──

describe("wire sends the 4-level `impact` only — never the 3-level `severity` band (ADR 0044 slice v(A), #153)", () => {
  // The engine now speaks impact on the wire: `impact` is always a valid 4-level value
  // (`critical|serious|moderate|minor|unknown`), and the 3-level `severity` band is no
  // longer sent at all (CiFindingInput.severity is optional platform-side).
  it("axe finding with runtime impact → POST `impact` is the 4-level value (`moderate`), and NO `severity`", async () => {
    // `moderate` is the sharp discriminator: the retired band collapsed it to `major`,
    // so if `impact` were still sourced from a band it would read `major` (an invalid impact).
    const wire = await capturePost(finding({ provenance: "axe", file: "https://example.com/p", line: 0, selector: "button", impact: "moderate" }), "/root");
    const [occ] = wire.variables.input.findings;
    expect(occ.impact).toBe("moderate");
    expect(occ.impact).not.toBe("major");
    expect(occ.severity).toBeUndefined(); // the band no longer travels on the wire
  });

  it("axe finding with `serious` impact → POST `impact` is `serious`", async () => {
    const wire = await capturePost(finding({ provenance: "axe", file: "https://example.com/p", line: 0, selector: "button", impact: "serious" }), "/root");
    const [occ] = wire.variables.input.findings;
    expect(occ.impact).toBe("serious");
  });

  it("finding with NO axe impact → POST `impact` falls back to the valid 4-level `\"unknown\"`, never the band", async () => {
    // A finding with no axe impact (e.g. an agent finding) sends `"unknown"` — the valid
    // 5th impact value — NOT the 3-level band (`major`), which parseImpact would drop.
    const wire = await capturePost(finding({ file: "/root/src/Button.tsx", line: 12 }), "/root");
    const [occ] = wire.variables.input.findings;
    expect(occ.impact).toBe("unknown");
    expect(occ.severity).toBeUndefined();
  });

  // The load-bearing cross-repo seam: kontrol's `ingestExternalFindings` input parse is
  // STRICT and REMOVED `severity` from CiFindingInput. An occurrence that still carries a
  // `severity` key is rejected as an unknown field ⇒ SILENT ingest break (checker succeeds
  // locally, nothing lands in the dashboard). This locks the EXACT wire occurrence keys so
  // a stray `severity` can never re-enter the payload without failing here first.
  const VALID_IMPACTS = new Set(["critical", "serious", "moderate", "minor", "unknown"]);
  it("the wire occurrence has EXACTLY the impact-only key set — `impact` present, `severity` key ABSENT", async () => {
    const wire = await capturePost(
      finding({ provenance: "axe", file: "https://example.com/p", line: 0, selector: "button", impact: "serious" }),
      "/root",
    );
    const [occ] = wire.variables.input.findings;
    // The complete occurrence contract kontrol's CiFindingInput accepts — no more, no less.
    expect(Object.keys(occ).sort()).toEqual(
      ["criterion", "description", "element", "evidence", "impact", "location", "recommendation", "seenAt"].sort(),
    );
    // `severity` is not merely undefined — the KEY does not exist (strict parse rejects unknown keys).
    expect("severity" in occ).toBe(false);
    // `impact` is present and a valid contract Impact value.
    expect(VALID_IMPACTS.has(occ.impact as string)).toBe(true);
  });
});

// ── Source-scan-scope coverage: scannedPaths (analyzed set) + deletedPaths (ADR 0043) ──

/** Capture the raw POST input for coverage-field assertions (superset of WireVars). */
async function captureInput(
  over: Partial<PhoneHomeDeps>,
): Promise<{ scannedTargets: string[]; scannedPaths: string[]; deletedPaths: string[] }> {
  let captured: { variables: { input: { scannedTargets: string[]; scannedPaths: string[]; deletedPaths: string[] } } } | undefined;
  const fetchSpy = vi.fn(async (_url: unknown, init: { body: string }) => {
    captured = JSON.parse(init.body);
    return new Response(JSON.stringify({ data: { ingestExternalFindings: { count: 1 } } }), { status: 200 });
  }) as unknown as typeof fetch;
  const { deps: d } = deps({ fetch: fetchSpy, ...over });
  await phoneHome([finding({ file: "/root/src/Button.tsx" })], "/root", FULL_ENV, d);
  if (captured === undefined) throw new Error("no POST captured");
  return captured.variables.input;
}

describe("scannedPaths — the analyzed-set coverage the source reconcile keys on", () => {
  it("narrows the run's ABSOLUTE analyzed set to repo-relative paths against root", async () => {
    // The analyzed set arrives absolute (ScanResult convention); it must land on the
    // wire relativized against the SAME root a source finding's `path` uses, so
    // membership (`scannedPaths.has(mf.path)`) matches by construction.
    const input = await captureInput({
      analyzedFiles: () => ["/root/src/Button.tsx", "/root/src/Nav.tsx"],
    });
    expect(input.scannedPaths).toEqual(["src/Button.tsx", "src/Nav.tsx"]);
  });

  it("scannedPaths shares the emitted finding's path vocabulary (reconcile membership holds)", async () => {
    // The emitted source finding is at /root/src/Button.tsx → path `src/Button.tsx`.
    // A clean analyzed sibling must sit in scannedPaths under the SAME vocabulary.
    const input = await captureInput({
      analyzedFiles: () => ["/root/src/Button.tsx", "/root/src/Clean.tsx"],
    });
    expect(input.scannedPaths).toContain("src/Button.tsx");
    expect(input.scannedPaths).toContain("src/Clean.tsx");
  });

  it("empty analyzed set → empty scannedPaths (safe default: resolves nothing)", async () => {
    const input = await captureInput({ analyzedFiles: () => [] });
    expect(input.scannedPaths).toEqual([]);
  });
});

describe("deletedPaths — TRUE deletions, threaded from the injected git seam", () => {
  it("threads the deletion set onto the wire verbatim (already repo-relative from git)", async () => {
    const input = await captureInput({ deletedPaths: () => ["src/Gone.tsx", "src/Removed.tsx"] });
    expect(input.deletedPaths).toEqual(["src/Gone.tsx", "src/Removed.tsx"]);
  });

  it("no deletion context → empty deletedPaths (never a fabricated deletion)", async () => {
    const input = await captureInput({ deletedPaths: () => [] });
    expect(input.deletedPaths).toEqual([]);
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

  it("trims incidental surrounding whitespace off stored credentials (#2180)", () => {
    // Presence is tested on the trimmed value; the STORED value must be trimmed too
    // so a padded credential isn't sent verbatim and rejected downstream.
    const r = resolveConfig({
      B8E_TOKEN: "  b8e_x  ",
      B8E_ORG_ID: " o\n",
      B8E_PROJECT_ID: "\tp ",
      B8E_AUDIT_ID: " a ",
      B8E_SCOPE: "  pr-42  ",
    });
    expect(r).toMatchObject({
      kind: "ready",
      config: { token: "b8e_x", orgID: "o", projectID: "p", auditID: "a", scope: "pr-42" },
    });
  });
});
