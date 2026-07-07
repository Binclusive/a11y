/**
 * The canonical finding shape a reporter consumes — the engine's `check --json`
 * output (ADR 0039, `@binclusive/a11y-contract`). This is the platform-NEUTRAL
 * input every {@link FindingsReporter} takes; it carries the source locators
 * (`ruleId`/`file`/`line`) an inline review surface anchors on, which the
 * metadata-only wire DTO (`emit-contract.ts`) deliberately drops.
 *
 * Lives here (not in a platform adapter) so the seam owns its own input type and
 * no adapter is the canonical home of the shape all adapters share. `pr-comment.ts`
 * re-exports these for its existing importers.
 */

import type { Impact } from "@binclusive/a11y-contract";

/** The contract's canonical impact scale — the `Impact` enum in `@binclusive/a11y-contract`. */
export type { Impact };

/** The subset of an a11y finding a reporter renders from — the `check --json` shape. */
export interface Finding {
  readonly ruleId: string;
  readonly file: string;
  readonly line: number;
  readonly message: string;
  readonly wcag?: readonly string[];
  /**
   * The finding's contract impact, carried through from the report so a
   * platform rollup can count by it. Optional: a report predating the field
   * simply buckets the finding as unclassified.
   */
  readonly impact?: Impact;
  /** The WCAG success-criterion id (contract `criterion`), e.g. "1.4.3". */
  readonly criterion?: string;
  /**
   * The CSS selector of the offending rendered element, on axe/DOM findings only
   * (source passes anchor by `file:line` and omit it). It is what distinguishes
   * two same-rule findings co-located at one `file:line`.
   */
  readonly selector?: string;
}

/** Narrow an unknown report value to the contract's impact enum. */
export function isImpact(value: unknown): value is Impact {
  return (
    value === "critical" ||
    value === "serious" ||
    value === "moderate" ||
    value === "minor" ||
    value === "unknown"
  );
}

/**
 * Boundary parse of the engine's findings JSON into the minimal shape a reporter
 * renders from. Unknown in, narrowed out — a malformed entry is dropped rather
 * than smuggling `any` inward (Parse-Don't-Validate at the reporter boundary).
 */
export function parseFindings(raw: unknown): Finding[] {
  if (typeof raw !== "object" || raw === null) return [];
  const findings = (raw as { findings?: unknown }).findings;
  if (!Array.isArray(findings)) return [];
  const out: Finding[] = [];
  for (const item of findings) {
    if (typeof item !== "object" || item === null) continue;
    const f = item as Record<string, unknown>;
    if (typeof f.ruleId !== "string" || typeof f.file !== "string") continue;
    // A line must be a real number: NaN/Infinity would anchor a review comment on a
    // nonexistent line, and `renderBody`/the marker would carry the junk value.
    if (typeof f.line !== "number" || !Number.isFinite(f.line)) continue;
    // Drop rather than synthesize an empty message: a comment with no body text is
    // noise on the PR, and the boundary shouldn't invent content the report lacks.
    if (typeof f.message !== "string" || f.message.trim() === "") continue;
    const wcag = Array.isArray(f.wcag) ? f.wcag.filter((w): w is string => typeof w === "string") : undefined;
    // Keep the selector across the boundary — it is what distinguishes co-located
    // same-rule findings; dropping it here reintroduces the collision.
    const selector = typeof f.selector === "string" ? f.selector : undefined;
    const impact = isImpact(f.impact) ? f.impact : undefined;
    // criterion is the contract's SC id; fall back to the first wcag tag so an
    // older report (no criterion field) still yields a by-WCAG breakdown.
    const criterion = typeof f.criterion === "string" && f.criterion !== "" ? f.criterion : wcag?.[0];
    out.push({
      ruleId: f.ruleId,
      file: f.file,
      line: f.line,
      message: f.message,
      ...(wcag ? { wcag } : {}),
      ...(selector !== undefined ? { selector } : {}),
      ...(impact !== undefined ? { impact } : {}),
      ...(criterion !== undefined ? { criterion } : {}),
    });
  }
  return out;
}
