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

describe("meterProvider", () => {
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
