/**
 * The low-cap pull loop — the runner harness.
 *
 * ONE pass per deterministic finding. Each pass gets a fresh per-finding lookup
 * budget and a provider metered against the shared per-PR token ceiling. The loop
 * is NON-BLOCKING by construction: {@link runAgentLane} returns a {@link RunOutcome}
 * for every input and NEVER rejects. Hitting the token ceiling is the `capped`
 * arm — a normal partial result (fewer findings), not an error. The caller can
 * always `exit 0`.
 *
 * The three seams the harness leaves clean:
 *   - #2096 reasoning skills   → the `AgentReasoner` (the prompt/system content).
 *   - #2097 code-graph lookups → the `LookupTool` the harness caps per finding.
 *   - #2098 enrich/discover    → the reasoner returns a `ReasonResult` (in-place
 *     enrichment + discoveries); the harness folds notes onto the source findings
 *     and dedups the discoveries against the deterministic floor.
 *
 * The emit boundary is the canonical contract: agent findings project through the
 * SAME `emit-contract` projection the deterministic engine uses (#2093), so no
 * file/line ever reaches the wire and there is one wire schema, not two. The
 * lenient variant drops a single malformed finding rather than failing the run.
 */
import { dedupeRecall } from "../core";
import type { EnrichedFinding } from "../corpus";
import { toFindingPayloadLenient } from "../emit-contract";
import type { FindingPayload } from "@binclusive/a11y-contract";
import { type BudgetSnapshot, meterProvider, TokenCeilingExceeded, TokenLedger } from "./budget";
import { LookupCounter, type LookupTool, meterLookup } from "./lookup";
import type { Provider } from "./provider";
import type { AgentFinding, AgentReasoner } from "./reasoner";

/** The low-cap knobs. Start low; dialing up is a separate concern (epic #2083). */
export interface RunnerConfig {
  /** Hard per-PR ceiling on `input + output` model tokens across all passes. */
  readonly tokenCeiling: number;
  /** Soft cap on structural lookups PER deterministic finding (~3-5). */
  readonly lookupsPerFinding: number;
}

export const DEFAULT_RUNNER_CONFIG: RunnerConfig = {
  tokenCeiling: 100_000,
  lookupsPerFinding: 5,
};

/**
 * Why one pass ended. A pass is atomic: it produces, is empty, errors, or never
 * ran. `produced` carries BOTH agent behaviors — how many findings it DISCOVERED
 * and whether it ENRICHED the source finding in place — so a note-only pass still
 * reads as productive, not empty.
 */
export type PassOutcome =
  | { readonly kind: "produced"; readonly discovered: number; readonly enriched: boolean }
  | { readonly kind: "empty" }
  | { readonly kind: "errored"; readonly reason: string }
  | { readonly kind: "skipped"; readonly reason: "token-ceiling" };

/** A local-only diagnostic record of one pass. Never crosses the wire. */
export interface PassReport {
  /** The deterministic finding's rule id — local diagnostics only, no file/line. */
  readonly ruleId: string;
  readonly lookupsUsed: number;
  readonly outcome: PassOutcome;
}

export interface RunInput {
  /** The deterministic findings (from the engine, already `enrich`ed). */
  readonly findings: readonly EnrichedFinding[];
  readonly reasoner: AgentReasoner;
  readonly provider: Provider;
  readonly lookup: LookupTool;
  /** The declared diff scope, carried onto every emitted finding. */
  readonly scope: string;
  readonly config?: RunnerConfig;
}

/**
 * The total outcome. Both arms carry a contract-validated {@link FindingPayload}
 * (possibly partial) AND the rich local findings (for local SARIF / PR comments).
 * There is no `failed` arm — the loop is non-blocking.
 *
 * `findings` are the DISCOVERED agent findings (deduped). `enrichedFindings` are
 * the input deterministic findings, in order, some now carrying an `agentNote`
 * from an in-place enrichment — they stay `provenance: deterministic` and feed the
 * deterministic (strict) emit + local render, never the agent payload.
 */
export type RunOutcome =
  | {
      readonly status: "complete";
      readonly payload: FindingPayload;
      readonly findings: readonly AgentFinding[];
      readonly enrichedFindings: readonly EnrichedFinding[];
      readonly passes: readonly PassReport[];
      readonly usage: BudgetSnapshot;
      /** Findings dropped at the emit boundary for failing the contract re-parse. */
      readonly dropped: number;
    }
  | {
      readonly status: "capped";
      readonly cappedBy: "token-ceiling";
      readonly payload: FindingPayload;
      readonly findings: readonly AgentFinding[];
      readonly enrichedFindings: readonly EnrichedFinding[];
      readonly passes: readonly PassReport[];
      readonly usage: BudgetSnapshot;
      /** Deterministic findings whose pass completed before the ceiling. */
      readonly processed: number;
      /** Deterministic findings skipped once the ceiling was reached. */
      readonly skipped: number;
      readonly dropped: number;
    };

/**
 * Drive the AI lane over the deterministic findings, capped and non-blocking.
 * Returns a {@link RunOutcome} for every input; never rejects.
 */
export async function runAgentLane(input: RunInput): Promise<RunOutcome> {
  const config = input.config ?? DEFAULT_RUNNER_CONFIG;
  const ledger = new TokenLedger(config.tokenCeiling);
  const provider = meterProvider(input.provider, ledger);

  const discoveries: AgentFinding[] = [];
  // Parallel to `input.findings`, in order: each finding as-is, or with an
  // `agentNote` folded on when its pass enriched it in place.
  const enrichedFindings: EnrichedFinding[] = [];
  const passes: PassReport[] = [];
  let processed = 0;
  let capped = false;

  for (let i = 0; i < input.findings.length; i += 1) {
    const finding = input.findings[i];

    // Pass boundary: a prior pass may have emptied the wallet. Skip the rest —
    // an unprocessed finding keeps its shape (no note), never fails.
    if (capped || ledger.exhausted()) {
      capped = true;
      enrichedFindings.push(finding);
      passes.push({ ruleId: finding.ruleId, lookupsUsed: 0, outcome: { kind: "skipped", reason: "token-ceiling" } });
      continue;
    }

    const counter = new LookupCounter(config.lookupsPerFinding);
    const lookup = meterLookup(input.lookup, counter);

    try {
      const result = await input.reasoner.reason({ finding, provider, lookup, scope: input.scope });
      // ENRICH in place: fold the note onto THIS deterministic finding (it stays
      // deterministic). DISCOVER: collect the new agent findings for later dedup.
      enrichedFindings.push(result.enrichment !== null ? { ...finding, agentNote: result.enrichment } : finding);
      discoveries.push(...result.discoveries);
      processed += 1;
      const produced = result.enrichment !== null || result.discoveries.length > 0;
      passes.push({
        ruleId: finding.ruleId,
        lookupsUsed: counter.used,
        outcome: produced
          ? { kind: "produced", discovered: result.discoveries.length, enriched: result.enrichment !== null }
          : { kind: "empty" },
      });
    } catch (error) {
      // Every non-cap failure leaves the finding un-enriched but present.
      enrichedFindings.push(finding);
      if (error instanceof TokenCeilingExceeded) {
        // The ceiling blew mid-pass. Discard this pass's partial work and stop
        // pulling new findings — the remaining ones are skipped, not failed.
        capped = true;
        passes.push({ ruleId: finding.ruleId, lookupsUsed: counter.used, outcome: { kind: "skipped", reason: "token-ceiling" } });
        continue;
      }
      // Any other failure is this pass's problem alone: record it, keep going.
      passes.push({ ruleId: finding.ruleId, lookupsUsed: counter.used, outcome: { kind: "errored", reason: reasonOf(error) } });
    }
  }

  // DEDUP (issue #2098): drop any discovery the deterministic floor already caught
  // (cross-dedup by file:line:sc) or that duplicates another discovery (self-dedup
  // by file:line:patternId). Reuse the engine's `dedupeRecall` verbatim — one dedup
  // discipline, not a second one. Survivors keep identity, so re-narrow to agent.
  const survivors = new Set(dedupeRecall(discoveries, input.findings));
  const agentFindings = discoveries.filter((d) => survivors.has(d));

  const { payload, dropped } = toFindingPayloadLenient(agentFindings, input.scope);
  const usage = ledger.snapshot();

  if (capped) {
    return {
      status: "capped",
      cappedBy: "token-ceiling",
      payload,
      findings: agentFindings,
      enrichedFindings,
      passes,
      usage,
      processed,
      skipped: input.findings.length - processed,
      dropped,
    };
  }
  return { status: "complete", payload, findings: agentFindings, enrichedFindings, passes, usage, dropped };
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
