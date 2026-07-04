/**
 * The reasoning-knowledge types — the shape of the audit-reasoning core the AI
 * lane consults. Ported from the `Binclusive-Accessibility-Skills` repo's
 * per-framework checklists + pattern catalogs (issue #2096) and reshaped from
 * loose markdown into typed, in-engine data, so the runner carries its own
 * reasoning with NO external agent-harness dependency.
 *
 * Two omissions encode the epic's law that the AI lane SUGGESTS, never applies:
 *   - {@link FixSuggestion} has no `patch` / `diff` / `edits` field. A suggestion
 *     is PROSE, never an applicable change — "fix = suggestions only" is
 *     unrepresentable to violate because this type carries no channel for a patch.
 *   - The reasoner is handed a provider + lookup + finding (`ReasonContext`),
 *     never a filesystem handle — so "nothing is written to the mounted source"
 *     holds by construction, not by policy.
 */

/** How safe applying a fix is — the trust label from the pattern catalog. */
export type FixType = "SAFE" | "VISUAL-IMPACT" | "FUNCTIONAL-RISK" | "RUNTIME-CHECK";

export const FIX_TYPES: readonly FixType[] = ["SAFE", "VISUAL-IMPACT", "FUNCTIONAL-RISK", "RUNTIME-CHECK"];

/** The catalog's severity vocabulary (distinct from axe's runtime impact). */
export type FixSeverity = "Critical" | "Serious" | "Moderate" | "Minor";

/**
 * One catalogued failure pattern — a ported pattern-catalog entry. The fields
 * mirror the skills repo's Pattern Entry Template so the prose survives the port
 * intact; the reasoner projects them into the system prompt.
 */
export interface PatternCatalogEntry {
  /** Stable catalog id, e.g. `PATTERN-REACT-001`. Provenance back to the corpus slice. */
  readonly id: string;
  readonly title: string;
  readonly componentType: string;
  /** WCAG SCs / APG patterns this addresses, e.g. `["2.1.1", "4.1.2"]`. */
  readonly wcag: readonly string[];
  readonly severityDefault: FixSeverity;
  /** The common-case trust label; the conditional nuance lives in {@link fixTypeNote}. */
  readonly fixTypeDefault: FixType;
  /** The catalog's "SAFE when …, FUNCTIONAL-RISK when …" conditional, preserved verbatim. */
  readonly fixTypeNote?: string;
  readonly badShape: string;
  readonly detectionHints: string;
  readonly correctFix: string;
  readonly verification: string;
  readonly exceptions: string;
}

/** A named group of checklist prose (e.g. "High-Risk React Patterns"). */
export interface ChecklistArea {
  readonly title: string;
  readonly items: readonly string[];
}

/** The per-framework reasoning core: checklist prose + pattern catalog. */
export interface FrameworkGuidance {
  /** Human framework name, e.g. `"React / Next.js"`. */
  readonly framework: string;
  /** When this guidance applies — the ported "use this reference only for …" scope. */
  readonly appliesTo: string;
  readonly checklist: readonly ChecklistArea[];
  readonly patterns: readonly PatternCatalogEntry[];
}

/**
 * A single fix the reasoner proposes for a finding — SUGGESTION ONLY. It carries
 * NO patch/diff: the fix is described in prose, never applied. This is the AI
 * lane's whole output vocabulary, and it is patch-free on purpose.
 */
export interface FixSuggestion {
  /** What the reasoner observed — grounds the suggestion in the finding. */
  readonly observation: string;
  /** The recommended fix in prose — the catalog's "correct fix" applied here. */
  readonly suggestedFix: string;
  /** WCAG SCs the suggestion addresses. */
  readonly wcag: readonly string[];
  /** How safe applying it is — the trust label carried onto the finding. */
  readonly fixType: FixType;
  /** The catalog pattern this matched, if any — provenance back to the corpus slice. */
  readonly patternId?: string;
}
