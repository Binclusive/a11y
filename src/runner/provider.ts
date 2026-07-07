/**
 * The provider abstraction — the BYO seam of the AI lane.
 *
 * The runner drives ANY language model through this ONE interface. Nothing here
 * names Anthropic, OpenAI, or any vendor: the customer implements {@link Provider}
 * over their OWN SDK and their OWN key, and injects it. The engine ships no LLM
 * credential and no vendor SDK — provider-agnostic by construction (epic #2083,
 * "BYO provider; Claude Code not required").
 *
 * The one hard requirement the runner places on a provider: every response must
 * report its {@link TokenUsage}. That is what makes the per-PR token ceiling
 * enforceable across an untrusted, vendor-specific model. A provider that cannot
 * report usage cannot be metered — so usage is part of the contract, not optional.
 */

/** One turn in a request. Vendor-neutral: `system` + a flat message list. */
export interface ProviderMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface ProviderRequest {
  /** Optional system framing (the reasoning skills live here — seam for #2096). */
  readonly system?: string;
  readonly messages: readonly ProviderMessage[];
  /** Upper bound on output tokens the caller wants; the provider may honor it. */
  readonly maxOutputTokens?: number;
}

/**
 * Token accounting for one completion. Both counts are required — the ceiling is
 * enforced on `inputTokens + outputTokens`, so a provider that omits either can't
 * be trusted to stay under budget.
 */
export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface ProviderResponse {
  readonly text: string;
  readonly usage: TokenUsage;
}

/**
 * The one method the runner calls. Implement it over your model of choice; the
 * runner meters every call against the per-PR token ceiling (see
 * {@link ./budget.meterProvider}). Implementations should surface transport
 * failures by rejecting — the runner treats a rejected pass as a non-fatal,
 * recorded error and keeps going (never fails the run).
 */
export interface Provider {
  readonly complete: (request: ProviderRequest) => Promise<ProviderResponse>;
}

/** The total tokens one usage record spends — meaningful only for a {@link isMeterableUsage | meterable} record. */
export function usageTotal(usage: TokenUsage): number {
  return usage.inputTokens + usage.outputTokens;
}

/**
 * Whether a usage record can be trusted against the ceiling: BOTH counts finite
 * and non-negative. A malformed provider response — `NaN`, `±Infinity`, or a
 * negative count — makes the ceiling comparison silently mis-evaluate
 * (`NaN >= ceiling` is always `false`), disabling the cap and letting the run
 * spend past budget. The ledger gates on this and treats an unmeterable usage as
 * AT-OR-OVER the ceiling, never under it (issue #2169).
 */
export function isMeterableUsage(usage: TokenUsage): boolean {
  const ok = (n: number): boolean => Number.isFinite(n) && n >= 0;
  return ok(usage.inputTokens) && ok(usage.outputTokens);
}
