/**
 * The reasoning-core registry — how the AI lane selects which per-framework
 * knowledge to consult for a given deterministic finding (issue #2096).
 *
 * React / TSX is the only framework wired for v1 (epic #2083). Selection is
 * intentionally narrow: a finding that isn't a React/web finding gets NO guidance,
 * and the reasoner treats "no guidance" as a normal "nothing to add" pass rather
 * than reasoning blind. Adding a framework is one entry here plus one guidance
 * module — the parked frameworks (React Native, iOS, Android, ASP.NET, Shopify)
 * slot in the same way.
 */
import type { Finding } from "../../core";
import { REACT_GUIDANCE } from "./react";
import type { FrameworkGuidance } from "./types";

export type { ChecklistArea, FixSeverity, FixSuggestion, FixType, FrameworkGuidance, PatternCatalogEntry } from "./types";
export { FIX_TYPES } from "./types";
export { REACT_GUIDANCE } from "./react";

/** Source-static provenances that fire on React/web JSX. */
const WEB_PROVENANCES: ReadonlySet<Finding["provenance"]> = new Set(["jsx-a11y", "enforce", "axe"]);

/** File extensions React guidance applies to. */
const REACT_EXTENSIONS: readonly string[] = [".tsx", ".jsx", ".ts", ".js", ".mjs", ".cjs"];

function isReactFinding(finding: Finding): boolean {
  if (WEB_PROVENANCES.has(finding.provenance)) return true;
  const file = finding.file.toLowerCase();
  return REACT_EXTENSIONS.some((ext) => file.endsWith(ext));
}

/**
 * The framework knowledge for one finding, or `null` when no wired framework
 * claims it. `null` is the reasoner's cue to add nothing — the honest floor when
 * the corpus has no reasoning to ground a suggestion in.
 */
export function frameworkGuidanceFor(finding: Finding): FrameworkGuidance | null {
  return isReactFinding(finding) ? REACT_GUIDANCE : null;
}
