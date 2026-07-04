/**
 * The reasoning seam — the AI-lane content the harness does NOT own.
 *
 * The harness drives ONE pass per deterministic finding and hands the reasoner a
 * metered provider and a capped lookup tool. What the reasoner DOES with them —
 * the prompt/skills (#2096), the code-graph queries (#2097), and the enrich +
 * discover logic that turns a model response into agent findings (#2098) — is
 * behind this interface. The harness stays content-free: it meters, loops, caps,
 * and emits; the reasoner reasons.
 *
 * The reasoner owns NO budget logic. It calls `ctx.provider.complete` and
 * `ctx.lookup.lookup` as if they were unbounded; the harness has already wrapped
 * both so the token ceiling and the per-finding lookup cap are enforced
 * underneath. This keeps #2096/#2098 free of cap plumbing.
 */
import type { EnrichedFinding } from "../corpus";
import type { LookupTool } from "./lookup";
import type { Provider } from "./provider";

/**
 * An agent finding is an {@link EnrichedFinding} on the `corpus-agent` arm — the
 * recall lane the emit projection routes to the contract's `agent` provenance.
 * Narrowing the provenance to the literal makes "an agent finding not tagged as an
 * agent finding" unrepresentable: the type itself is the guarantee that whatever
 * the reasoner returns will project to the contract's agent arm, never the
 * deterministic one.
 */
export type AgentFinding = EnrichedFinding & { readonly provenance: "corpus-agent" };

/** Everything one pass gets: the finding to reason about, plus the metered tools. */
export interface ReasonContext {
  /** The deterministic finding this pass enriches / discovers around. */
  readonly finding: EnrichedFinding;
  /** Metered against the per-PR token ceiling by the harness. */
  readonly provider: Provider;
  /** Capped at the per-finding lookup budget by the harness. */
  readonly lookup: LookupTool;
  /** The declared diff scope, carried onto every emitted finding. */
  readonly scope: string;
}

export interface AgentReasoner {
  /**
   * Produce zero or more agent findings for one deterministic finding. Returning
   * `[]` is a normal "nothing to add" pass. Rejecting is allowed — the harness
   * records the pass as a non-fatal error and continues; a reasoner failure never
   * fails the run.
   */
  readonly reason: (ctx: ReasonContext) => Promise<readonly AgentFinding[]>;
}
