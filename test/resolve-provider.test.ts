/**
 * `resolveProvider` env contract — the seam the GitHub Action plumbs into
 * (issue #2188). The Action wires `llm-model`/`llm-provider` inputs to
 * `LLM_MODEL`/`LLM_PROVIDER` container env with a `default: ""`, so an unset
 * override arrives as an EMPTY STRING, not `undefined`. These lock the
 * empty-is-default behavior so a bare BYOK key still runs the AI lane.
 */
import { describe, expect, it } from "vitest";
import { resolveProvider } from "../src/agent-lane";

const KEY = "sk-test-key";

describe("resolveProvider — env contract for the Action plumbing", () => {
  it("no key → null (deterministic floor, not an error)", () => {
    expect(resolveProvider({})).toBeNull();
    expect(resolveProvider({ LLM_API_KEY: "" })).toBeNull();
    expect(resolveProvider({ LLM_API_KEY: "   " })).toBeNull();
  });

  it("key + absent provider → the default provider runs", () => {
    expect(resolveProvider({ LLM_API_KEY: KEY })).not.toBeNull();
  });

  it("key + EMPTY provider → default provider (the Action's `default: \"\"` passthrough)", () => {
    // Regression guard for #2188: `?? "anthropic"` only defaults on undefined,
    // so an empty string used to select no provider and silently disable the lane.
    expect(resolveProvider({ LLM_API_KEY: KEY, LLM_PROVIDER: "" })).not.toBeNull();
    expect(resolveProvider({ LLM_API_KEY: KEY, LLM_PROVIDER: "   " })).not.toBeNull();
  });

  it("key + explicit `anthropic` (any case) → a provider", () => {
    expect(resolveProvider({ LLM_API_KEY: KEY, LLM_PROVIDER: "anthropic" })).not.toBeNull();
    expect(resolveProvider({ LLM_API_KEY: KEY, LLM_PROVIDER: "ANTHROPIC" })).not.toBeNull();
    expect(resolveProvider({ LLM_API_KEY: KEY, LLM_PROVIDER: "  Anthropic  " })).not.toBeNull();
  });

  it("key + unrecognized provider → null (degrade to the floor, never throw)", () => {
    expect(resolveProvider({ LLM_API_KEY: KEY, LLM_PROVIDER: "openai" })).toBeNull();
  });

  it("an empty LLM_MODEL is tolerated (default model, provider still resolves)", () => {
    expect(resolveProvider({ LLM_API_KEY: KEY, LLM_MODEL: "" })).not.toBeNull();
    expect(resolveProvider({ LLM_API_KEY: KEY, LLM_MODEL: "claude-opus-4-5" })).not.toBeNull();
  });
});
