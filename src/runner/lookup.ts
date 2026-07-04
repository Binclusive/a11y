/**
 * The structural-lookup seam — how the reasoner asks about code STRUCTURE
 * (which component renders this, where a prop flows) without reading raw source
 * into a model prompt. The concrete implementation is `tools/code-graph` (#2097);
 * the harness only defines the interface and enforces the per-finding cap.
 *
 * A lookup is a SOFT cap, unlike the token ceiling. "one pass per finding + ~3-5
 * lookups" (issue #2095): exceeding the lookup budget yields a `capped` result the
 * reasoner reads as "finalize with what you have" — FEWER lookups, still a
 * finding. Only the token ceiling is hard (it ends the run). Lookups spend no
 * model tokens, so they are metered on their own count-based budget, independent
 * of the token ledger.
 */

/**
 * A structural query. Left deliberately open — `kind`/`target` are the minimal
 * shape the harness needs to pass a query through; #2097 owns the real taxonomy
 * of queries the code-graph answers.
 */
export interface LookupQuery {
  readonly kind: string;
  readonly target: string;
}

export type LookupResult =
  | { readonly status: "ok"; readonly data: unknown }
  /** The per-finding lookup budget is spent — finalize the pass with what you have. */
  | { readonly status: "capped" };

/** The seam #2097 implements over the code-graph. */
export interface LookupTool {
  readonly lookup: (query: LookupQuery) => Promise<LookupResult>;
}

/** Counts lookups against a per-finding budget. Fresh per pass. */
export class LookupCounter {
  #used = 0;

  constructor(readonly cap: number) {}

  get used(): number {
    return this.#used;
  }

  exhausted(): boolean {
    return this.#used >= this.cap;
  }

  /** Charge one lookup slot. Called by {@link meterLookup} before it delegates. */
  charge(): void {
    this.#used += 1;
  }
}

/**
 * Wrap a lookup tool so it stops delegating once the per-finding cap is reached,
 * returning `{ status: "capped" }` instead. Soft by design: the reasoner keeps
 * going and produces a finding from what it already learned. The slot is charged
 * before delegating, so a throwing tool still consumes its budget.
 */
export function meterLookup(tool: LookupTool, counter: LookupCounter): LookupTool {
  return {
    async lookup(query) {
      if (counter.exhausted()) return { status: "capped" };
      counter.charge();
      return tool.lookup(query);
    },
  };
}
