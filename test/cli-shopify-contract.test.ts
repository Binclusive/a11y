import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeContext } from "@effect/platform-node";
import { Finding as ContractFinding } from "@binclusive/a11y-contract";
import { Effect, Exit } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCheckShopify, runCli } from "../src/cli";

/**
 * The #163 CONNECTED-SEAM tracer for the Shopify/Liquid stack.
 *
 * The collector (`scanLiquid`) and the wire projection (`toContractFinding`) are
 * each unit-true already — but until #163 the assembled path never RAN: a Shopify
 * scan could only reach a bespoke `buildJsonReport`→stdout report, never a real
 * consumer of the canonical `@binclusive/a11y-contract` shape. These tests drive
 * the REAL CLI emit path end to end (collector → enrich → contract projection →
 * serialized output) and prove a Liquid finding lands as a canonical contract
 * `Finding` on a real consumer — SARIF, and the phone-home projection.
 *
 * In-process only (no browser, no toolchain), so this lives in the fast unit tier.
 */

const here = dirname(fileURLToPath(import.meta.url));
// `bad.liquid` in this theme has known structural violations (img with no alt,
// icon-only control with no accessible name, iframe with no title).
const themeDir = join(here, "fixtures", "liquid-theme");
const IMG_NO_ALT = "liquid/img-no-alt";

/**
 * Drive the root command with a synthetic argv (verb + flags), capturing stdout.
 * The first two slots stand in for `node` + the script path, which `Command.run`
 * strips. Mirrors the harness in `cli-swift.e2e.test.ts` / `cli-commands.test.ts`.
 */
async function runVerb(
  args: readonly string[],
): Promise<{ stdout: string; exit: Exit.Exit<void, unknown>; exitCode: number | undefined }> {
  const out: string[] = [];
  const logSpy = vi.spyOn(console, "log").mockImplementation((...a) => {
    out.push(a.join(" "));
  });
  const savedExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    const exit = await Effect.runPromiseExit(
      runCli(["node", "a11y-checker", ...args]).pipe(Effect.provide(NodeContext.layer)),
    );
    // Capture the runner's exit code BEFORE the finally restores it — the gate sets
    // `process.exitCode`, so a caller asserting on the gate must read it here.
    return { stdout: out.join("\n"), exit, exitCode: process.exitCode };
  } finally {
    logSpy.mockRestore();
    process.exitCode = savedExitCode;
  }
}

describe("check-shopify → the canonical contract wire path (#163 connected-seam tracer)", () => {
  it("`check-shopify <theme> --format sarif` emits a valid SARIF doc carrying the Liquid finding", async () => {
    const { stdout, exit, exitCode } = await runVerb(["check-shopify", themeDir, "--format", "sarif"]);
    expect(Exit.isSuccess(exit)).toBe(true);

    // The assembled path serialized a real SARIF 2.1.0 doc — not the bespoke report.
    const sarif = JSON.parse(stdout);
    expect(sarif.version).toBe("2.1.0");
    expect(sarif.runs).toHaveLength(1);

    // A Liquid finding reached the consumer, tagged with its canonical contract
    // provenance (`toContractProvenance("liquid") === "deterministic"`).
    const results: Array<{ ruleId?: string; properties?: { provenance?: string } }> = sarif.runs[0].results;
    const imgNoAlt = results.find((r) => r.ruleId === IMG_NO_ALT);
    expect(imgNoAlt).toBeDefined();
    expect(imgNoAlt?.properties?.provenance).toBe("deterministic");

    // Unified gate (#176): the stack scan gates EXACTLY like `check`, independent of
    // output format. With no binclusive.json the findings are advisory (warn, ADR
    // 0010), so the run exits 0 in every format — the old advisory-on-machine-format
    // split (sarif/json exit 0 while text exited 1) is gone because BOTH now agree.
    expect(exitCode ?? 0).toBe(0);
  });

  it("`check-shopify --json` phone-home projects the Liquid scan through `toContractFinding` (ContractFinding.parse succeeds)", async () => {
    // Configure the phone-home path and capture the POSTed batch with a stub fetch —
    // the SAME injection seam `runCheck` exposes for the agent-lane tracer. The
    // envelope is built by the REAL emit path (assembleEnvelopes → toFindingPayloadLenient
    // → toContractFinding), so capturing the wire proves the assembled projection ran.
    const savedEnv = { ...process.env };
    Object.assign(process.env, {
      B8E_TOKEN: "b8e_test_token",
      B8E_ORG_ID: "org_test",
      B8E_PROJECT_ID: "proj_test",
      B8E_AUDIT_ID: "audit_test",
      B8E_INGEST_URL: "https://kontrol.test/graphql",
    });

    let captured: { provenance: string; scope: string; findings: Array<Record<string, unknown>> } | null = null;
    const capturingFetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      captured = body.variables.input;
      return new Response(JSON.stringify({ data: { ingestExternalFindings: { count: captured?.findings.length ?? 0 } } }), { status: 200 });
    }) as unknown as typeof fetch;

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const savedExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await runCheckShopify(themeDir, "json", "tracer-run", { fetch: capturingFetch, log: () => {} });
    } finally {
      logSpy.mockRestore();
      process.exitCode = savedExitCode;
      process.env = savedEnv;
    }

    // The real emit path POSTed exactly one deterministic envelope (all Liquid
    // findings are deterministic-provenance).
    expect(capturingFetch).toHaveBeenCalledTimes(1);
    expect(captured).not.toBeNull();
    const input = captured!;
    expect(input.provenance).toBe("deterministic");

    // Reconstruct the canonical contract `Finding` from the envelope-level provenance
    // + the metadata-only wire occurrence (the wire adds transport extras — impact,
    // description, seenAt — that the moat `Finding` omits; ADR 0044 slice v). The
    // reconstruction IS the emitted finding; that it parses proves the serialized
    // output is a canonical `@binclusive/a11y-contract` `Finding`.
    const occ = input.findings.find((f) => f.element === IMG_NO_ALT);
    expect(occ).toBeDefined();
    const finding = ContractFinding.parse({
      provenance: input.provenance,
      location: occ!.location,
      criterion: occ!.criterion,
      element: occ!.element,
      evidence: occ!.evidence,
      scope: input.scope,
    });
    expect(finding.provenance).toBe("deterministic");
    expect(finding.element).toBe(IMG_NO_ALT);

    // Metadata-only wire shape (ADR 0039/0042): a source finding rides a
    // `{path,lineHash,index}` fingerprint — never a `file:line` or a raw snippet.
    expect((occ!.location as { kind: string }).kind).toBe("source");
    expect(occ).not.toHaveProperty("file");
    expect(occ).not.toHaveProperty("line");
  });
});
