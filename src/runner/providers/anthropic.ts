/**
 * The concrete, ship-in-the-box {@link Provider} — Anthropic's Messages API over
 * global `fetch` (epic #2083, issue #2182).
 *
 * The {@link Provider} interface (`../provider`) is the BYO seam: nothing in the
 * runner names a vendor, and a customer can still inject their own model. This
 * module fills that seam with ONE default implementation so a bare `LLM_API_KEY`
 * drives the AI lane end to end — no vendor SDK, no extra install. The engine
 * ships lean: the whole provider is a single `fetch` POST, mapping the vendor-
 * neutral {@link ProviderRequest} onto the Anthropic request body and the reply
 * back onto {@link ProviderResponse} (crucially, its {@link TokenUsage} — the
 * runner's token ceiling is only enforceable because usage is reported).
 *
 * Per the {@link Provider} contract, this SURFACES transport failures by
 * REJECTING: a non-2xx, a malformed body, or a network error throws. The runner
 * catches a rejected pass and records it as a non-fatal error, so a provider
 * that throws degrades the run to "no agent findings for that pass", never a
 * crash — the AI lane stays non-blocking.
 */
import type { Provider, ProviderRequest, ProviderResponse, TokenUsage } from "../provider";

/**
 * The default model for the low-cap advisory CI lane: a fast, cost-appropriate
 * model. Overridable via the provider config (wired to `LLM_MODEL`), so dialing
 * up to a stronger model is one env var, not a code change.
 */
export const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";

/** Anthropic's dated API version header — pinned so a server-side default shift can't drift the shape. */
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_BASE_URL = "https://api.anthropic.com";
/** A pass is one short suggestion; cap output when the caller doesn't ask. */
const DEFAULT_MAX_OUTPUT_TOKENS = 1024;

export interface AnthropicProviderConfig {
  /** The customer's Anthropic key (from `LLM_API_KEY`). Never logged. */
  readonly apiKey: string;
  /** Model id. Defaults to {@link DEFAULT_ANTHROPIC_MODEL}. */
  readonly model?: string;
  /** Injectable for tests / alternate gateways. Defaults to `globalThis.fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Override the API origin (self-hosted gateway / proxy). Defaults to Anthropic. */
  readonly baseUrl?: string;
}

/** Anthropic's `messages` response, narrowed at the boundary — never trusted raw. */
interface AnthropicResponseBody {
  readonly content?: ReadonlyArray<{ readonly type?: string; readonly text?: string }>;
  readonly usage?: { readonly input_tokens?: number; readonly output_tokens?: number };
}

/** Concatenate the text blocks of a Messages reply into one string. */
function textOf(body: AnthropicResponseBody): string {
  if (!Array.isArray(body.content)) return "";
  return body.content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

/**
 * A single reported token count, or `+Infinity` when the body reports it absent,
 * non-numeric, `NaN`, or negative. Anthropic always reports both counts; a body
 * that doesn't is malformed, so we parse-don't-validate at the boundary and map
 * the bad count to a fail-closed sentinel rather than silently charging 0. The
 * ledger meters `+Infinity` as at-or-over the ceiling, stopping the lane instead
 * of letting a malformed response run past the cap (issue #2169).
 */
function meterableCount(raw: number | undefined): number {
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : Number.POSITIVE_INFINITY;
}

/**
 * The token usage the runner meters against the per-PR ceiling — parsed from the
 * untrusted body, never read raw. A missing or malformed count maps to `+Infinity`
 * (see {@link meterableCount}) so the ceiling fails closed on a bad provider
 * response rather than under-counting toward a silent overspend.
 */
function usageOf(body: AnthropicResponseBody): TokenUsage {
  return {
    inputTokens: meterableCount(body.usage?.input_tokens),
    outputTokens: meterableCount(body.usage?.output_tokens),
  };
}

/**
 * Build the ship-in-the-box Anthropic {@link Provider}. Inject into the runner's
 * `RunInput.provider`; the harness meters every `complete` call against the token
 * ceiling. Rejects on any transport / shape failure — the runner treats that as a
 * non-fatal, recorded pass error.
 */
export function createAnthropicProvider(config: AnthropicProviderConfig): Provider {
  const model = config.model ?? DEFAULT_ANTHROPIC_MODEL;
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  const endpoint = `${config.baseUrl ?? DEFAULT_BASE_URL}/v1/messages`;

  return {
    async complete(request: ProviderRequest): Promise<ProviderResponse> {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": config.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model,
          max_tokens: request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
          ...(request.system !== undefined ? { system: request.system } : {}),
          messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
        }),
      });

      if (!response.ok) {
        // Surface as a rejection — the runner records the pass as a non-fatal
        // error and keeps going. The key never reaches the message.
        throw new Error(`Anthropic API returned HTTP ${response.status}`);
      }

      const body = (await response.json()) as AnthropicResponseBody;
      return { text: textOf(body), usage: usageOf(body) };
    },
  };
}
