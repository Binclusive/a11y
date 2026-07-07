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
  type Location as ContractLocation,
  parseFindingPayload,
  type Provenance as ContractProvenance,
} from "@binclusive/a11y-contract";
import type { FindingProvenance } from "./core";
import type { EnrichedFinding } from "./evidence";
import { type LocationOptions, resolveLocations } from "./source-identity";

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
 * Project one enriched local finding onto the contract DTO, given its already
 * resolved wire {@link ContractLocation}. Every source locator (`file`, `line`,
 * `ruleId`, raw line content) is dropped: the ONLY location that crosses is the
 * pre-computed `location` — a page `url`, or a source `{ path, lineHash, index }`
 * fingerprint carrying neither the line number nor the content (ADR 0042). `index`
 * disambiguation is a batch property, so the location is resolved by the batch
 * ({@link toFindingPayload}) and threaded in here, keeping this projection pure.
 *
 * `element` falls back to the rule id when there is no rendered DOM selector — a
 * source-static pass has no live element, and the rule id is the honest non-source
 * locator for the occurrence.
 */
export function toContractFinding(
  f: EnrichedFinding,
  scope: string,
  location: ContractLocation,
): ContractFinding {
  const base = {
    location,
    criterion: f.wcag[0] ?? "",
    element: hasSelector(f.selector) ? f.selector : f.ruleId,
    evidence: f.message,
    scope,
  } as const;

  if (toContractProvenance(f.provenance) === "agent") {
    return { provenance: "agent", ...base, rationale: f.message };
  }
  return { provenance: "deterministic", ...base };
}

/**
 * The emit path: project a batch of local findings onto the wire payload and
 * re-parse it through the contract's own schema. The parse is the boundary
 * guarantee — a payload that drifts from the metadata-only shape throws here
 * (`ZodError`) rather than reaching the platform.
 *
 * Locations are resolved for the WHOLE batch up front — a source finding's
 * `index` disambiguates identical line-content within one file, so it can only be
 * assigned with the batch in hand (ADR 0042). `options` injects the repo root
 * (for the relative `path`) and the line-content source (default: read from disk).
 */
export function toFindingPayload(
  findings: readonly EnrichedFinding[],
  scope: string,
  options?: LocationOptions,
): FindingPayload {
  const locations = resolveLocations(findings, options);
  return parseFindingPayload({
    findings: findings.map((f) => toContractFinding(f, scope, mustLocate(locations, f))),
  });
}

/** A finding is always in the resolved map ({@link resolveLocations} covers the batch). */
function mustLocate(locations: ReadonlyMap<EnrichedFinding, ContractLocation>, f: EnrichedFinding): ContractLocation {
  const location = locations.get(f);
  if (location === undefined) throw new Error("finding missing from resolved location map");
  return location;
}

/** A lenient emit that projects each finding independently, keeping the valid ones. */
export interface LenientPayload {
  readonly payload: FindingPayload;
  /** How many findings failed the contract re-parse and were dropped. */
  readonly dropped: number;
  /**
   * The enriched sources that SURVIVED projection, in `payload.findings` order (1:1).
   * The metadata-only wire `Finding` carries no impact field, so a transport layer
   * that must send the 4-level `impact` (Kontrol's `CiFindingInput` extra) reads it
   * off the paired source here — no second projection, and no widening of the wire
   * contract.
   */
  readonly sources: readonly EnrichedFinding[];
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
export function toFindingPayloadLenient(
  findings: readonly EnrichedFinding[],
  scope: string,
  options?: LocationOptions,
): LenientPayload {
  const locations = resolveLocations(findings, options);
  const projected: ContractFinding[] = [];
  const sources: EnrichedFinding[] = [];
  let dropped = 0;
  for (const f of findings) {
    // Guard the WHOLE projection, not just the parse: a malformed finding can
    // throw inside toContractFinding (a bad wcag/corpus shape) as easily as it
    // can fail the schema. Either way the one finding is dropped, never the run.
    const contract = tryProject(f, scope, locations.get(f));
    if (contract === null) dropped += 1;
    else {
      // Push in lockstep so `sources[i]` is the source `payload.findings[i]` came
      // from — the alignment a transport layer relies on to recover a source-only field.
      projected.push(contract);
      sources.push(f);
    }
  }
  return { payload: parseFindingPayload({ findings: projected }), dropped, sources };
}

/** Project one finding, returning `null` if it throws, has no location, or fails the contract. */
function tryProject(
  f: EnrichedFinding,
  scope: string,
  location: ContractLocation | undefined,
): ContractFinding | null {
  if (location === undefined) return null;
  try {
    const parsed = ContractFindingSchema.safeParse(toContractFinding(f, scope, location));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
