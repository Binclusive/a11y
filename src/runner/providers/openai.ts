/**
 * A second ship-in-the-box {@link Provider} — OpenAI's Chat Completions API over
 * global `fetch` (epic #2083, issue #2318).
 *
 * The {@link Provider} interface (`../provider`) is the BYO seam: nothing in the
 * runner names a vendor. This module is the OpenAI twin of `./anthropic.ts` —
 * ONE more concrete default so a customer with `LLM_PROVIDER=openai` + a bare
 * `LLM_API_KEY` drives the AI lane end to end, no vendor SDK, no extra install.
 * It maps the vendor-neutral {@link ProviderRequest} onto the Chat Completions
 * request body and the reply back onto {@link ProviderResponse} (crucially its
 * {@link TokenUsage} — the runner's token ceiling is only enforceable because
 * usage is reported).
 *
 * Two vendor-shape differences from Anthropic, and nothing else changes:
 *   - the system prompt is a leading `role: "system"` message, not a top-level
 *     field; and
 *   - usage is `prompt_tokens` / `completion_tokens`, the reply text is
 *     `choices[].message.content`.
 *
 * Per the {@link Provider} contract, this SURFACES transport failures by
 * REJECTING: a non-2xx, a malformed body, or a network error throws. The runner
 * catches a rejected pass and records it as a non-fatal error, so a provider
 * that throws degrades the run to "no agent findings for that pass", never a
 * crash — the AI lane stays non-blocking.
 *
 * A HANG is a failure a `throw` alone does not cover, so the `fetch` is bounded
 * by an {@link AbortController} + timeout (mirroring `./anthropic.ts`). A stalled
 * provider — network stall, provider outage, no response — is aborted at the
 * bound and surfaced as a rejection like any other transport failure, so the
 * runner records the pass as errored and keeps going. Without this, a single hung
 * request would hang the whole CI job, turning the non-blocking soft-degrade into
 * a hard block on the customer's PR pipeline (issue #2192).
 */
import type { Provider, ProviderRequest, ProviderResponse, TokenUsage } from "../provider";

/**
 * The default model for the low-cap advisory CI lane: a fast, cost-appropriate
 * model. Overridable via the provider config (wired to `LLM_MODEL`), so dialing
 * up to a stronger model is one env var, not a code change.
 */
export const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";

const DEFAULT_BASE_URL = "https://api.openai.com";
/** A pass is one short suggestion; cap output when the caller doesn't ask. */
const DEFAULT_MAX_OUTPUT_TOKENS = 1024;

/**
 * The safe default wall-clock bound on one provider request (issue #2192). A
 * low-cap advisory completion (≤ {@link DEFAULT_MAX_OUTPUT_TOKENS} output tokens
 * on a fast model) returns in seconds; 60s leaves generous headroom for a slow
 * healthy response while still bounding a genuine hang, so a stalled request
 * aborts and degrades the AI lane softly instead of stalling CI. Override via
 * {@link OpenAIProviderConfig.timeoutMs} (wired to `LLM_TIMEOUT_MS`).
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

export interface OpenAIProviderConfig {
  /** The customer's OpenAI key (from `LLM_API_KEY`). Never logged. */
  readonly apiKey: string;
  /** Model id. Defaults to {@link DEFAULT_OPENAI_MODEL}. */
  readonly model?: string;
  /** Injectable for tests / alternate gateways. Defaults to `globalThis.fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Override the API origin (Azure OpenAI / self-hosted gateway / proxy). Defaults to OpenAI. */
  readonly baseUrl?: string;
  /**
   * Wall-clock bound on one request before it aborts (from `LLM_TIMEOUT_MS`).
   * Defaults to {@link DEFAULT_REQUEST_TIMEOUT_MS}. A non-finite or non-positive
   * value falls back to the default — a bad knob can't disable the bound and
   * re-open the hang hole (issue #2192).
   */
  readonly timeoutMs?: number;
}

/** OpenAI's `chat/completions` response, narrowed at the boundary — never trusted raw. */
interface OpenAIResponseBody {
  readonly choices?: ReadonlyArray<{ readonly message?: { readonly content?: string | null } }>;
  readonly usage?: { readonly prompt_tokens?: number; readonly completion_tokens?: number };
}

/** Concatenate the message content of the returned choices into one string. */
function textOf(body: OpenAIResponseBody): string {
  if (!Array.isArray(body.choices)) return "";
  return body.choices
    .map((choice) => choice.message?.content)
    .filter((content): content is string => typeof content === "string")
    .join("");
}

/**
 * A single reported token count, or `+Infinity` when the body reports it absent,
 * non-numeric, `NaN`, or negative. OpenAI always reports both counts; a body
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
function usageOf(body: OpenAIResponseBody): TokenUsage {
  return {
    inputTokens: meterableCount(body.usage?.prompt_tokens),
    outputTokens: meterableCount(body.usage?.completion_tokens),
  };
}

/**
 * Build the ship-in-the-box OpenAI {@link Provider}. Inject into the runner's
 * `RunInput.provider`; the harness meters every `complete` call against the token
 * ceiling. Rejects on any transport / shape failure — the runner treats that as a
 * non-fatal, recorded pass error.
 */
export function createOpenAIProvider(config: OpenAIProviderConfig): Provider {
  const model = config.model ?? DEFAULT_OPENAI_MODEL;
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  const endpoint = `${config.baseUrl ?? DEFAULT_BASE_URL}/v1/chat/completions`;
  const timeoutMs =
    typeof config.timeoutMs === "number" && Number.isFinite(config.timeoutMs) && config.timeoutMs > 0
      ? config.timeoutMs
      : DEFAULT_REQUEST_TIMEOUT_MS;

  return {
    async complete(request: ProviderRequest): Promise<ProviderResponse> {
      // Bound the whole exchange — connect AND body read: a hang at either stage
      // aborts at the timeout and surfaces as a rejection, closing the
      // non-blocking hole a bare `throw` can't (#2192). We own this controller,
      // so any abort here IS our timeout. The signal cancels an in-flight body
      // read too, so a stalled response can't slip past a resolved-headers fetch.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify({
            model,
            max_tokens: request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
            // OpenAI carries the system framing as a leading message, not a
            // top-level field (the one shape divergence from Anthropic).
            messages: [
              ...(request.system !== undefined ? [{ role: "system", content: request.system }] : []),
              ...request.messages.map((m) => ({ role: m.role, content: m.content })),
            ],
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          // Surface as a rejection — the runner records the pass as a non-fatal
          // error and keeps going. The key never reaches the message.
          throw new Error(`OpenAI API returned HTTP ${response.status}`);
        }

        const body = (await response.json()) as OpenAIResponseBody;
        return { text: textOf(body), usage: usageOf(body) };
      } catch (error) {
        if (controller.signal.aborted) throw new Error(`OpenAI request timed out after ${timeoutMs}ms`);
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
