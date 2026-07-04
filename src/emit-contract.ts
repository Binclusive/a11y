/**
 * The wire projection: `localFinding -> contract`.
 *
 * The engine's canonical model is the source-anchored, corpus-enriched
 * {@link EnrichedFinding} (carries `file`/`line`/`selector`/`ruleId`). It is the
 * single internal source of truth and NEVER leaves the customer's machine.
 *
 * The imported `@binclusive/a11y-contract` `Finding` is the METADATA-ONLY WIRE
 * DTO — the narrowing boundary projection this module owns. It is what the
 * phone-home / ingestion path emits. The projection deliberately DROPS every
 * source locator (`file`, `line`, `ruleId`, `helpUrl`) so no source can cross
 * the wire: metadata-only by construction, on top of the contract's own
 * `.strict()` allowlist. This is Parse-Don't-Validate at the emit boundary —
 * {@link toFindingPayload} re-parses the assembled batch through the contract's
 * own schema, so an engine that drifts from the shape fails loud here, not on
 * the platform.
 *
 * This is NOT a competing schema. There is ONE model (the local finding) and
 * ONE wire DTO (the contract). Local renderers (the PR-comment reviewer, the
 * SARIF renderer) read the RICH local finding directly and never route through
 * this narrowing — only the emit path does.
 */
import {
  Finding as ContractFindingSchema,
  type Finding as ContractFinding,
  type FindingPayload,
  parseFindingPayload,
  type Provenance as ContractProvenance,
  type Severity as ContractSeverity,
} from "@binclusive/a11y-contract";
import type { FindingProvenance } from "./core";
import { corpusSeverity, corpusTier, type EnrichedFinding, type Severity as AxeImpact } from "./corpus";

/**
 * The ONE axe-impact -> contract-severity mapping. axe's runtime vocabulary has
 * four levels; the contract (and the persisted `agentic_finding.severity`) has
 * three. `serious` and `moderate` both land on `major` — the single place this
 * collapse is defined. Every severity-emitting surface (SARIF, ticket) routes
 * through here so they can never disagree.
 */
const IMPACT_TO_SEVERITY: Record<AxeImpact, ContractSeverity> = {
  critical: "critical",
  serious: "major",
  moderate: "major",
  minor: "minor",
};

export function impactToSeverity(impact: AxeImpact): ContractSeverity {
  return IMPACT_TO_SEVERITY[impact];
}

/**
 * A deterministic finding whose SC is in neither the audit corpus nor the
 * baseline catalog (and which carries no runtime axe impact) still fired a real
 * rule — it is a genuine violation with no severity signal to read. `major`
 * (SARIF `warning`) is the honest floor: it neither fabricates `critical` nor
 * understates a real finding to a `note`.
 */
const DEFAULT_SEVERITY: ContractSeverity = "major";

/** The finding's contract severity: its resolved axe impact narrowed to the 3-level enum. */
export function contractSeverity(f: EnrichedFinding): ContractSeverity {
  const impact = corpusSeverity(f);
  return impact === null ? DEFAULT_SEVERITY : impactToSeverity(impact);
}

/**
 * Collapse the engine's 7-value {@link FindingProvenance} onto the contract's
 * binary origin: the corpus-grounded agent layer is `agent`; every deterministic
 * static/rendered pass (`jsx-a11y`/`enforce`/`axe`/`swiftui`/`liquid`/`unity`)
 * is `deterministic`.
 */
export function toContractProvenance(p: FindingProvenance): ContractProvenance {
  return p === "corpus-agent" ? "agent" : "deterministic";
}

/**
 * A selector locates a live rendered element. Empty or whitespace-only is NOT a
 * selector — a source-static pass has no live DOM node, and `??` would let `""`
 * through as if it were present. The single predicate both the SARIF
 * logicalLocation and the contract `element` fallback read, so the two can never
 * disagree on "present vs absent".
 */
export function hasSelector(selector: string | undefined): selector is string {
  return selector !== undefined && selector.trim() !== "";
}

/**
 * Project one enriched local finding onto the contract DTO, dropping every
 * source locator. `element` falls back to the rule id when there is no rendered
 * DOM selector — a source-static pass has no live element, and the rule id is
 * the honest non-source locator for the occurrence.
 */
export function toContractFinding(f: EnrichedFinding, scope: string): ContractFinding {
  const base = {
    criterion: f.wcag[0] ?? "",
    severity: contractSeverity(f),
    element: hasSelector(f.selector) ? f.selector : f.ruleId,
    evidence: f.message,
    scope,
  } as const;

  if (toContractProvenance(f.provenance) === "agent") {
    return { provenance: "agent", ...base, rationale: f.message };
  }
  return { provenance: "deterministic", ...base, tier: corpusTier(f.corpus) };
}

/**
 * The emit path: project a batch of local findings onto the wire payload and
 * re-parse it through the contract's own schema. The parse is the boundary
 * guarantee — a payload that drifts from the metadata-only shape throws here
 * (`ZodError`) rather than reaching the platform.
 */
export function toFindingPayload(findings: readonly EnrichedFinding[], scope: string): FindingPayload {
  return parseFindingPayload({ findings: findings.map((f) => toContractFinding(f, scope)) });
}

/** A lenient emit that projects each finding independently, keeping the valid ones. */
export interface LenientPayload {
  readonly payload: FindingPayload;
  /** How many findings failed the contract re-parse and were dropped. */
  readonly dropped: number;
}

/**
 * The NON-BLOCKING emit path — same projection as {@link toFindingPayload}, but a
 * single finding that fails the contract re-parse is DROPPED, not thrown.
 *
 * Two emit disciplines, one projection: the deterministic engine emits with the
 * strict {@link toFindingPayload} (its output is reproducible — drift is a bug that
 * must fail loud). The AI lane emits with THIS — one malformed model output must
 * never fail the whole run (the runner always exits 0). Both reuse
 * {@link toContractFinding} + the contract's own `Finding` schema, so there is no
 * second projection and no second wire schema.
 */
export function toFindingPayloadLenient(findings: readonly EnrichedFinding[], scope: string): LenientPayload {
  const projected: ContractFinding[] = [];
  let dropped = 0;
  for (const f of findings) {
    // Guard the WHOLE projection, not just the parse: a malformed finding can
    // throw inside toContractFinding (a bad wcag/corpus shape) as easily as it
    // can fail the schema. Either way the one finding is dropped, never the run.
    const contract = tryProject(f, scope);
    if (contract === null) dropped += 1;
    else projected.push(contract);
  }
  return { payload: parseFindingPayload({ findings: projected }), dropped };
}

/** Project one finding, returning `null` if it throws or fails the contract. */
function tryProject(f: EnrichedFinding, scope: string): ContractFinding | null {
  try {
    const parsed = ContractFindingSchema.safeParse(toContractFinding(f, scope));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
