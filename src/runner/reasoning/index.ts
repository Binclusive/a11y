/**
 * The reasoning-core registry — how the AI lane selects which per-framework
 * knowledge to consult for a given deterministic finding (issue #2096, #2319).
 *
 * React / TSX (epic #2083) and Shopify Liquid themes (#2319) are wired. Selection
 * is intentionally narrow: a finding no wired framework claims gets NO guidance,
 * and the reasoner treats "no guidance" as a normal "nothing to add" pass rather
 * than reasoning blind. Adding a framework is one entry here plus one guidance
 * module — the parked frameworks (React Native, iOS, Android, ASP.NET, Angular,
 * Flutter) slot in the same way.
 *
 * Shopify is matched BEFORE React because the `liquid` provenance is the authority
 * for a theme finding: a theme's `assets/*.js`/`*.css` file would otherwise be
 * claimed by React's extension list. Provenance-first keeps the two seams disjoint.
 */
import type { Finding } from "../../core";
import { REACT_GUIDANCE } from "./react";
import { SHOPIFY_GUIDANCE } from "./shopify";
import type { FrameworkGuidance } from "./types";

export type { ChecklistArea, Discovery, FixSeverity, FixSuggestion, FixType, FrameworkGuidance, PatternCatalogEntry } from "./types";
export { FIX_TYPES } from "./types";
export { REACT_GUIDANCE } from "./react";
export { SHOPIFY_GUIDANCE } from "./shopify";

/** Source-static provenances that fire on React/web JSX. */
const WEB_PROVENANCES: ReadonlySet<Finding["provenance"]> = new Set(["jsx-a11y", "enforce", "axe"]);

/** File extensions React guidance applies to. */
const REACT_EXTENSIONS: readonly string[] = [".tsx", ".jsx", ".ts", ".js", ".mjs", ".cjs"];

function isReactFinding(finding: Finding): boolean {
  if (WEB_PROVENANCES.has(finding.provenance)) return true;
  const file = finding.file.toLowerCase();
  return REACT_EXTENSIONS.some((ext) => file.endsWith(ext));
}

/** A Shopify theme finding — tagged `liquid`, or a `.liquid` template/section/snippet. */
function isShopifyFinding(finding: Finding): boolean {
  if (finding.provenance === "liquid") return true;
  return finding.file.toLowerCase().endsWith(".liquid");
}

/**
 * The framework knowledge for one finding, or `null` when no wired framework
 * claims it. `null` is the reasoner's cue to add nothing — the honest floor when
 * the corpus has no reasoning to ground a suggestion in.
 */
export function frameworkGuidanceFor(finding: Finding): FrameworkGuidance | null {
  if (isShopifyFinding(finding)) return SHOPIFY_GUIDANCE;
  if (isReactFinding(finding)) return REACT_GUIDANCE;
  return null;
}
