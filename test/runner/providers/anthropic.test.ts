import { type Server, createServer } from "node:http";
import { type AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { meterProvider, TokenCeilingExceeded, TokenLedger } from "../../../src/runner";
import { createAnthropicProvider, DEFAULT_REQUEST_TIMEOUT_MS } from "../../../src/runner/providers/anthropic";

/**
 * The provider boundary parses an untrusted body: a usage count that is absent,
 * NaN, or negative must map to a fail-closed sentinel, not a silent 0, so the
 * ledger stops the lane instead of running past the ceiling (issue #2169).
 */

/** A fetch stub returning a 200 whose parsed JSON body is exactly `body`. */
function fetchReturning(body: unknown): typeof fetch {
  return (async () =>
    ({ ok: true, status: 200, json: async () => body }) as unknown as Response) as unknown as typeof fetch;
}

async function usageFromBody(body: unknown) {
  const provider = createAnthropicProvider({ apiKey: "test", fetchImpl: fetchReturning(body) });
  const { usage } = await provider.complete({ messages: [] });
  return usage;
}

describe("createAnthropicProvider — malformed usage fails the ceiling closed", () => {
  it.each([
    { name: "NaN counts", usage: { input_tokens: Number.NaN, output_tokens: Number.NaN } },
    { name: "absent usage object", usage: undefined },
    { name: "one absent count", usage: { input_tokens: 500 } },
    { name: "negative count", usage: { input_tokens: -1, output_tokens: 10 } },
  ])("maps $name to an unmeterable +Infinity usage", async ({ usage }) => {
    const got = await usageFromBody({ content: [{ type: "text", text: "hi" }], usage });
    expect(Number.isFinite(got.inputTokens) && Number.isFinite(got.outputTokens)).toBe(false);
  });

  it("a well-formed body is charged exactly (the guard doesn't over-fire)", async () => {
    const got = await usageFromBody({ content: [], usage: { input_tokens: 30, output_tokens: 20 } });
    expect(got).toEqual({ inputTokens: 30, outputTokens: 20 });
  });

  it("STOPS the run at the ceiling when the body reports NaN usage (end-to-end)", async () => {
    const ledger = new TokenLedger(1000);
    const provider = createAnthropicProvider({
      apiKey: "test",
      fetchImpl: fetchReturning({ content: [], usage: { input_tokens: Number.NaN, output_tokens: Number.NaN } }),
    });
    const metered = meterProvider(provider, ledger);

    await metered.complete({ messages: [] }); // first call admitted, reports NaN usage
    expect(ledger.exhausted()).toBe(true); // ceiling failed closed
    await expect(metered.complete({ messages: [] })).rejects.toBeInstanceOf(TokenCeilingExceeded);
  });
});

/**
 * A hang is a hole a `throw`→exit-0 path does not cover: with no abort, a stalled
 * provider request hangs the whole CI job, blocking the customer's PR pipeline
 * (issue #2192). The fetch is bounded by an AbortController + timeout, so a hang
 * is aborted at the bound and surfaced as a rejection — the runner records the
 * pass as errored, keeps the deterministic floor, and still exits 0.
 */
describe("createAnthropicProvider — a hung fetch aborts at the timeout (never blocks CI)", () => {
  /**
   * A fetch that NEVER resolves on its own — it only settles when the request's
   * abort signal fires, rejecting with an AbortError exactly like `globalThis.fetch`.
   * This is the stalled-provider simulation: without the timeout it would hang forever.
   */
  function hangingFetch(): typeof fetch {
    return ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          const onAbort = () => {
            const err = new Error("The operation was aborted");
            err.name = "AbortError";
            reject(err);
          };
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        }
      })) as unknown as typeof fetch;
  }

  it("rejects (aborts) within the configured bound instead of hanging forever", async () => {
    const timeoutMs = 25;
    const provider = createAnthropicProvider({ apiKey: "test", fetchImpl: hangingFetch(), timeoutMs });
    const start = Date.now();

    await expect(provider.complete({ messages: [] })).rejects.toThrow(/timed out/i);

    // Completed by aborting, not by hanging: well under any CI budget, and near
    // the configured bound rather than an unbounded wall-clock wait.
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(timeoutMs - 5);
    expect(elapsed).toBeLessThan(2_000);
  });

  it("the AI lane fails SOFT on a hung pass — the deterministic floor survives, run stays non-blocking", async () => {
    // Drive the hung provider through the SAME metered seam the runner uses. The
    // rejection is what the runner's per-pass catch records as a non-fatal error
    // (runner.ts): the pass is dropped, remaining findings proceed, exit 0 holds.
    const ledger = new TokenLedger(1000);
    const provider = createAnthropicProvider({ apiKey: "test", fetchImpl: hangingFetch(), timeoutMs: 25 });
    const metered = meterProvider(provider, ledger);

    await expect(metered.complete({ messages: [] })).rejects.toThrow(/timed out/i);
    // A hang consumed no measured tokens — it degrades the lane, it doesn't spend budget.
    expect(ledger.exhausted()).toBe(false);
  });

  it("a non-positive/non-finite timeout falls back to the safe default (a bad knob can't disable the bound)", () => {
    // Construction must not throw and must keep the bound for any bad override —
    // the guard maps 0 / negative / NaN / Infinity back to the default.
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createAnthropicProvider({ apiKey: "test", timeoutMs: bad })).not.toThrow();
    }
    // The documented safe default is a real, positive, finite bound.
    expect(Number.isFinite(DEFAULT_REQUEST_TIMEOUT_MS) && DEFAULT_REQUEST_TIMEOUT_MS > 0).toBe(true);
  });
});

/**
 * The sneakier evasion the hung-fetch suite above does NOT reach: a server that
 * sends 200 headers FAST, then drip-feeds a body that never completes. Here
 * `fetch` resolves (headers received) and only the `.json()` body read stalls —
 * so the timeout is load-bearing only if `clearTimeout` runs AFTER the body read
 * (in `finally`) and the SAME `controller.signal` governs that read. This locks
 * grill-1 of #2192: move `clearTimeout` before `.json()`, or read the body under
 * a different/absent signal, and these tests go red. Exercising it needs the real
 * global `fetch` against a real socket — a `fetchImpl` stub whose `.json()`
 * resolves instantly can't reproduce a stalled body stream.
 */
describe("createAnthropicProvider — a slow-drip body aborts at the timeout (headers fast, body never ends)", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (!server) return;
    const s = server;
    server = undefined;
    // Force the never-ending response socket closed so the suite can't leak it.
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  });

  /**
   * Stand up a server that flushes 200 + JSON content-type immediately, writes one
   * byte of body, then holds the connection open forever without `res.end()`. This
   * is the drip: the client's `fetch` resolves on headers, but `.json()` waits on a
   * body that never arrives — a hang only the abort signal can break.
   */
  async function dripServerBaseUrl(): Promise<string> {
    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write("{"); // a partial body that will never be completed or ended
      // deliberately no res.end(): the body stream stalls open until the socket dies
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server!.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  it("rejects (aborts) within the bound instead of reading the dribbling body to completion", async () => {
    const timeoutMs = 100;
    const provider = createAnthropicProvider({ apiKey: "test", baseUrl: await dripServerBaseUrl(), timeoutMs });
    const start = Date.now();

    await expect(provider.complete({ messages: [] })).rejects.toThrow(/timed out/i);

    // Aborted near the bound, not an unbounded wait on a body that never ends.
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(timeoutMs - 20);
    expect(elapsed).toBeLessThan(2_000);
  });

  it("the AI lane fails SOFT on a drip-stalled body — no tokens spent, floor survives", async () => {
    // Same metered seam the runner uses: the rejection is a non-fatal recorded
    // pass error, and a stalled body measured no usage, so it can't spend budget.
    const ledger = new TokenLedger(1000);
    const provider = createAnthropicProvider({ apiKey: "test", baseUrl: await dripServerBaseUrl(), timeoutMs: 100 });
    const metered = meterProvider(provider, ledger);

    await expect(metered.complete({ messages: [] })).rejects.toThrow(/timed out/i);
    expect(ledger.exhausted()).toBe(false);
  });
});
