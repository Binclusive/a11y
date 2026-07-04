/**
 * The HARD per-PR token ceiling — the load-bearing cap of the low-cap loop.
 *
 * The ceiling is enforced in two layers that converge on the same terminal state
 * ("capped"), never on a failure:
 *   1. At each PASS boundary the runner asks {@link TokenLedger.exhausted}; once
 *      true, every remaining deterministic finding is skipped.
 *   2. Mid-pass, {@link meterProvider} REFUSES a model call the moment the wallet
 *      is empty, throwing {@link TokenCeilingExceeded}. This is the runaway guard:
 *      a reasoner that loops model calls inside one pass cannot outrun the ceiling.
 *
 * The single in-flight call may overshoot the ceiling: you cannot know a model
 * call's true cost before making it, so the meter admits a call while ANY budget
 * remains and accounts for it after. Overshoot is bounded by one call — an honest
 * "hard ceiling", not a fantasy of pre-metered spend.
 *
 * The throw is a bulkhead, not general control flow: it is caught in exactly one
 * place (the runner's per-pass guard) and converted immediately into the `capped`
 * arm of `RunOutcome`. The runner's public surface never throws.
 */
import type { Provider, TokenUsage } from "./provider";
import { usageTotal } from "./provider";

/** A read-only view of the ledger, safe to hand out in a `RunOutcome`. */
export interface BudgetSnapshot {
  readonly ceiling: number;
  readonly used: number;
  readonly remaining: number;
}

/** Thrown by {@link meterProvider} when a model call is attempted with no budget left. */
export class TokenCeilingExceeded extends Error {
  constructor(
    readonly ceiling: number,
    readonly used: number,
  ) {
    super(`per-PR token ceiling reached: used ${used} of ${ceiling}`);
    this.name = "TokenCeilingExceeded";
  }
}

/** Accumulates model-token spend against a fixed ceiling. */
export class TokenLedger {
  #used = 0;

  constructor(readonly ceiling: number) {}

  get used(): number {
    return this.#used;
  }

  get remaining(): number {
    return Math.max(0, this.ceiling - this.#used);
  }

  /** No budget remains — the next pass must be skipped. */
  exhausted(): boolean {
    return this.#used >= this.ceiling;
  }

  record(usage: TokenUsage): void {
    this.#used += usageTotal(usage);
  }

  snapshot(): BudgetSnapshot {
    return { ceiling: this.ceiling, used: this.#used, remaining: this.remaining };
  }
}

/**
 * Wrap a provider so every completion is charged to the ledger. A call attempted
 * with an already-empty wallet throws {@link TokenCeilingExceeded} instead of
 * spending — this is the hard stop that makes the ceiling a ceiling.
 */
export function meterProvider(provider: Provider, ledger: TokenLedger): Provider {
  return {
    async complete(request) {
      if (ledger.exhausted()) throw new TokenCeilingExceeded(ledger.ceiling, ledger.used);
      const response = await provider.complete(request);
      ledger.record(response.usage);
      return response;
    },
  };
}
