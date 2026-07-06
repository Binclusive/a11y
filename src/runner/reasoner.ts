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
import type { EnrichedFinding } from "../evidence";
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

/**
 * What ONE pass produces — the two agent behaviors, kept structurally distinct so
 * "enrich" and "discover" can never be confused (issue #2098):
 *
 *   - {@link enrichment} ENRICHES the source deterministic finding IN PLACE: a
 *     prose note the harness folds onto that finding, which stays
 *     `provenance: deterministic`. `null` means "nothing to add to this one".
 *   - {@link discoveries} DISCOVERS new issues the deterministic engine missed —
 *     standalone `corpus-agent` findings. `[]` means "found nothing new".
 *
 * Both come out of the SAME single model call, so a pass still costs one provider
 * turn (the low-cap "one pass/finding" discipline the harness meters).
 */
export interface ReasonResult {
  /** An in-place note for the SOURCE deterministic finding, or `null`. Prose, never a patch. */
  readonly enrichment: string | null;
  /** New `corpus-agent` findings the deterministic pass missed. `[]` is a normal empty pass. */
  readonly discoveries: readonly AgentFinding[];
}

/** The empty pass — nothing to enrich, nothing discovered. */
export const EMPTY_RESULT: ReasonResult = { enrichment: null, discoveries: [] };

export interface AgentReasoner {
  /**
   * Reason about one deterministic finding, producing a {@link ReasonResult}.
   * Returning {@link EMPTY_RESULT} is a normal "nothing to add" pass. Rejecting is
   * allowed — the harness records the pass as a non-fatal error and continues; a
   * reasoner failure never fails the run.
   */
  readonly reason: (ctx: ReasonContext) => Promise<ReasonResult>;
}
