import { describe, expect, it } from "vitest";
import {
  meterProvider,
  type Provider,
  TokenCeilingExceeded,
  TokenLedger,
} from "../../src/runner";

/** The primitives the loop's non-blocking guarantee rests on. */

describe("TokenLedger", () => {
  it("accounts input + output and reports remaining, floored at 0", () => {
    const ledger = new TokenLedger(100);
    expect(ledger.exhausted()).toBe(false);
    ledger.record({ inputTokens: 30, outputTokens: 20 });
    expect(ledger.used).toBe(50);
    expect(ledger.remaining).toBe(50);
    ledger.record({ inputTokens: 40, outputTokens: 40 }); // overshoots
    expect(ledger.used).toBe(130);
    expect(ledger.remaining).toBe(0);
    expect(ledger.exhausted()).toBe(true);
  });
});

describe("TokenLedger — fail-closed on malformed usage (issue #2169)", () => {
  // `NaN >= ceiling` is always false, so a NaN spend would silently disable the
  // cap forever. Each malformed report must instead exhaust the wallet.
  it.each([
    { name: "NaN", usage: { inputTokens: Number.NaN, outputTokens: 10 } },
    { name: "Infinity", usage: { inputTokens: 10, outputTokens: Number.POSITIVE_INFINITY } },
    { name: "negative", usage: { inputTokens: -1000, outputTokens: 10 } },
  ])("treats $name usage as AT-OR-OVER the ceiling, not under it", ({ usage }) => {
    const ledger = new TokenLedger(100);
    ledger.record(usage);
    expect(ledger.exhausted()).toBe(true);
    expect(ledger.remaining).toBe(0);
  });

  it("a malformed report cannot un-exhaust a wallet real spend already filled", () => {
    const ledger = new TokenLedger(100);
    ledger.record({ inputTokens: 60, outputTokens: 20 }); // 80, still under
    ledger.record({ inputTokens: Number.NaN, outputTokens: 0 }); // malformed → over
    expect(ledger.exhausted()).toBe(true);
  });
});

describe("meterProvider", () => {
  it("STOPS the run at the ceiling when a provider returns NaN usage (issue #2169)", async () => {
    const ledger = new TokenLedger(100);
    // A provider stub whose usage is NaN — the bug: this used to slip past the cap.
    const provider: Provider = {
      complete: async () => ({ text: "x", usage: { inputTokens: Number.NaN, outputTokens: Number.NaN } }),
    };
    const metered = meterProvider(provider, ledger);

    await metered.complete({ messages: [] }); // admitted once (wallet had budget), reports NaN usage
    expect(ledger.exhausted()).toBe(true); // ceiling now fails closed, not open
    // the very next call is refused — the cap holds instead of spending forever
    await expect(metered.complete({ messages: [] })).rejects.toBeInstanceOf(TokenCeilingExceeded);
  });

  it("charges each call and admits calls while ANY budget remains (overshoot by one)", async () => {
    const ledger = new TokenLedger(100);
    const provider: Provider = { complete: async () => ({ text: "x", usage: { inputTokens: 60, outputTokens: 20 } }) };
    const metered = meterProvider(provider, ledger);

    await metered.complete({ messages: [] }); // 80 spent, still under 100
    expect(ledger.used).toBe(80);
    await metered.complete({ messages: [] }); // admitted (budget remained), overshoots to 160
    expect(ledger.used).toBe(160);
    expect(ledger.exhausted()).toBe(true);
  });

  it("REFUSES a call once the wallet is empty (the hard stop)", async () => {
    const ledger = new TokenLedger(50);
    ledger.record({ inputTokens: 50, outputTokens: 0 }); // exactly exhausted
    const provider: Provider = { complete: async () => ({ text: "x", usage: { inputTokens: 1, outputTokens: 1 } }) };
    const metered = meterProvider(provider, ledger);

    await expect(metered.complete({ messages: [] })).rejects.toBeInstanceOf(TokenCeilingExceeded);
    expect(ledger.used).toBe(50); // no further spend
  });
});
