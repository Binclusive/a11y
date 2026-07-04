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
 * Project one enriched local finding onto the contract DTO, dropping every
 * source locator. `element` falls back to the rule id when there is no rendered
 * DOM selector — a source-static pass has no live element, and the rule id is
 * the honest non-source locator for the occurrence.
 */
export function toContractFinding(f: EnrichedFinding, scope: string): ContractFinding {
  const base = {
    criterion: f.wcag[0] ?? "",
    severity: contractSeverity(f),
    element: f.selector ?? f.ruleId,
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
