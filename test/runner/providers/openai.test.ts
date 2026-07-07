import { describe, expect, it } from "vitest";
import { meterProvider, TokenCeilingExceeded, TokenLedger } from "../../../src/runner";
import { createOpenAIProvider, DEFAULT_REQUEST_TIMEOUT_MS } from "../../../src/runner/providers/openai";

/**
 * The OpenAI twin of `anthropic.test.ts`: the same non-blocking-by-construction
 * invariants, exercised against OpenAI's `chat/completions` shape (`prompt_tokens`
 * / `completion_tokens`, `choices[].message.content`). The provider boundary
 * parses an untrusted body: a usage count that is absent, NaN, or negative must
 * map to a fail-closed sentinel, not a silent 0, so the ledger stops the lane
 * instead of running past the ceiling (issue #2169).
 */

/** A fetch stub returning a 200 whose parsed JSON body is exactly `body`. */
function fetchReturning(body: unknown): typeof fetch {
  return (async () =>
    ({ ok: true, status: 200, json: async () => body }) as unknown as Response) as unknown as typeof fetch;
}

async function usageFromBody(body: unknown) {
  const provider = createOpenAIProvider({ apiKey: "test", fetchImpl: fetchReturning(body) });
  const { usage } = await provider.complete({ messages: [] });
  return usage;
}

describe("createOpenAIProvider — reply text is extracted from choices", () => {
  it("concatenates the returned choices' message content", async () => {
    const provider = createOpenAIProvider({
      apiKey: "test",
      fetchImpl: fetchReturning({
        choices: [{ message: { content: "advisory note" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    });
    const { text } = await provider.complete({ messages: [] });
    expect(text).toBe("advisory note");
  });

  it("a garbage reply (no choices) yields empty text, never a throw", async () => {
    const provider = createOpenAIProvider({ apiKey: "test", fetchImpl: fetchReturning({}) });
    const { text } = await provider.complete({ messages: [] });
    expect(text).toBe("");
  });
});

describe("createOpenAIProvider — the output-token field is picked by model family", () => {
  /** A 200-returning fetch stub that records each request's raw JSON body. */
  function capturingFetch(): { bodies: string[]; fetchImpl: typeof fetch } {
    const bodies: string[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ""));
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    return { bodies, fetchImpl };
  }

  async function fieldsSentFor(model: string): Promise<string[]> {
    const { bodies, fetchImpl } = capturingFetch();
    await createOpenAIProvider({ apiKey: "test", model, fetchImpl }).complete({ messages: [] });
    return Object.keys(JSON.parse(bodies[0]));
  }

  it.each(["o1", "o1-mini", "o3-mini", "gpt-5", "gpt-5-mini", "GPT-5-nano"])(
    "reasoning model %s → sends max_completion_tokens (not max_tokens)",
    async (model) => {
      const fields = await fieldsSentFor(model);
      expect(fields).toContain("max_completion_tokens");
      expect(fields).not.toContain("max_tokens");
    },
  );

  it.each(["gpt-4o-mini", "gpt-4o", "gpt-4-turbo", "gpt-3.5-turbo"])(
    "standard model %s → sends max_tokens (not max_completion_tokens)",
    async (model) => {
      const fields = await fieldsSentFor(model);
      expect(fields).toContain("max_tokens");
      expect(fields).not.toContain("max_completion_tokens");
    },
  );

  it("the shipped default model uses max_tokens (a bare BYOK key still runs)", async () => {
    const { bodies, fetchImpl } = capturingFetch();
    // No `model` override → DEFAULT_OPENAI_MODEL, which must take the legacy field.
    await createOpenAIProvider({ apiKey: "test", fetchImpl }).complete({ messages: [] });
    expect(Object.keys(JSON.parse(bodies[0]))).toContain("max_tokens");
  });
});

describe("createOpenAIProvider — malformed usage fails the ceiling closed", () => {
  it.each([
    { name: "NaN counts", usage: { prompt_tokens: Number.NaN, completion_tokens: Number.NaN } },
    { name: "absent usage object", usage: undefined },
    { name: "one absent count", usage: { prompt_tokens: 500 } },
    { name: "negative count", usage: { prompt_tokens: -1, completion_tokens: 10 } },
  ])("maps $name to an unmeterable +Infinity usage", async ({ usage }) => {
    const got = await usageFromBody({ choices: [{ message: { content: "hi" } }], usage });
    expect(Number.isFinite(got.inputTokens) && Number.isFinite(got.outputTokens)).toBe(false);
  });

  it("a well-formed body is charged exactly (the guard doesn't over-fire)", async () => {
    const got = await usageFromBody({ choices: [], usage: { prompt_tokens: 30, completion_tokens: 20 } });
    expect(got).toEqual({ inputTokens: 30, outputTokens: 20 });
  });

  it("STOPS the run at the ceiling when the body reports NaN usage (end-to-end)", async () => {
    const ledger = new TokenLedger(1000);
    const provider = createOpenAIProvider({
      apiKey: "test",
      fetchImpl: fetchReturning({ choices: [], usage: { prompt_tokens: Number.NaN, completion_tokens: Number.NaN } }),
    });
    const metered = meterProvider(provider, ledger);

    await metered.complete({ messages: [] }); // first call admitted, reports NaN usage
    expect(ledger.exhausted()).toBe(true); // ceiling failed closed
    await expect(metered.complete({ messages: [] })).rejects.toBeInstanceOf(TokenCeilingExceeded);
  });
});

describe("createOpenAIProvider — a non-2xx surfaces as a rejection (recorded, non-fatal)", () => {
  it("throws on an HTTP error without leaking the key", async () => {
    const errorFetch = (async () =>
      ({ ok: false, status: 429, json: async () => ({}) }) as unknown as Response) as unknown as typeof fetch;
    const provider = createOpenAIProvider({ apiKey: "sk-secret", fetchImpl: errorFetch });
    await expect(provider.complete({ messages: [] })).rejects.toThrow(/HTTP 429/);
    await expect(provider.complete({ messages: [] })).rejects.not.toThrow(/sk-secret/);
  });
});

/**
 * A hang is a hole a `throw`→exit-0 path does not cover: with no abort, a stalled
 * provider request hangs the whole CI job, blocking the customer's PR pipeline
 * (issue #2192). The fetch is bounded by an AbortController + timeout, so a hang
 * is aborted at the bound and surfaced as a rejection — the runner records the
 * pass as errored, keeps the deterministic floor, and still exits 0.
 */
describe("createOpenAIProvider — a hung fetch aborts at the timeout (never blocks CI)", () => {
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
    const provider = createOpenAIProvider({ apiKey: "test", fetchImpl: hangingFetch(), timeoutMs });
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
    const provider = createOpenAIProvider({ apiKey: "test", fetchImpl: hangingFetch(), timeoutMs: 25 });
    const metered = meterProvider(provider, ledger);

    await expect(metered.complete({ messages: [] })).rejects.toThrow(/timed out/i);
    // A hang consumed no measured tokens — it degrades the lane, it doesn't spend budget.
    expect(ledger.exhausted()).toBe(false);
  });

  it("a non-positive/non-finite timeout falls back to the safe default (a bad knob can't disable the bound)", () => {
    // Construction must not throw and must keep the bound for any bad override —
    // the guard maps 0 / negative / NaN / Infinity back to the default.
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createOpenAIProvider({ apiKey: "test", timeoutMs: bad })).not.toThrow();
    }
    // The documented safe default is a real, positive, finite bound.
    expect(Number.isFinite(DEFAULT_REQUEST_TIMEOUT_MS) && DEFAULT_REQUEST_TIMEOUT_MS > 0).toBe(true);
  });
});
