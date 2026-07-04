import { describe, expect, it } from "vitest";
import { meterProvider, TokenCeilingExceeded, TokenLedger } from "../../../src/runner";
import { createAnthropicProvider } from "../../../src/runner/providers/anthropic";

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
