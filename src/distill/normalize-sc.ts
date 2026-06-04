/**
 * Normalize a raw `wcag_criterion` field from the audit corpus into canonical
 * WCAG Success Criterion code(s).
 *
 * The raw field is a mess — the corpus was written by many auditors and tools
 * over time. Observed shapes (all real):
 *   - bare SC:           "4.1.2", "1.3.1"
 *   - prefixed:          "WCAG 2.4.4"
 *   - smushed:           "wcag244", "wcag246"
 *   - SC + label suffix: "2.1.1 Keyboard", "2.4.1 Bypass Blocks", "2.4.3 Focus Order"
 *   - multi-code blob:    "4.1.2, 3.3.2", "1.3.1, 1.3.2, 4.1.1"
 *   - axe rule ids:       "heading-order", "link-name", "image-alt", ...
 *   - junk:               "site-inaccessible", "site-unreachable", "asd"
 *
 * Strategy: collect EVERY `N.N.N` (or `N.N`) sequence found anywhere in the
 * string (covers bare / prefixed / suffixed / multi-code), plus the smushed
 * `wcagNNN` form, plus a lookup table for the axe rule-ids. De-duped, sorted.
 * Returns `[]` for anything that canonicalizes to nothing — the caller logs it
 * to the drop ledger rather than silently losing it.
 */

/**
 * axe-core rule id -> WCAG SC(s). Only the ids actually seen in the corpus plus
 * the common ones named in the distillation spec. Extend as new ids appear.
 */
export const AXE_RULE_TO_SC: Readonly<Record<string, readonly string[]>> = {
  "heading-order": ["1.3.1"],
  "link-name": ["2.4.4"],
  "image-alt": ["1.1.1"],
  "image-alt-redundant": ["1.1.1"],
  "landmark-one-main": ["1.3.1"],
  "label-title-only": ["3.3.2", "4.1.2"],
  "aria-allowed-attr": ["4.1.2"],
  "aria-hidden-focus": ["4.1.2"],
  "keyboard-operable": ["2.1.1"],
  "button-name": ["4.1.2"],
  "select-name": ["4.1.2"],
  "frame-title": ["4.1.2"],
};

/** Matches an SC number anywhere in a string: `N.N` or `N.N.N` (up to N.N.NN). */
const SC_PATTERN = /\b([1-4])\.(\d{1,2})(?:\.(\d{1,2}))?\b/g;

/** Matches the smushed `wcag244` form. */
const SMUSHED_PATTERN = /wcag\s*([1-4])(\d)(\d{1,2})/gi;

/**
 * Normalize one raw criterion value to canonical SC code(s).
 * Order-independent input; output is de-duped and sorted.
 */
export function normalizeCriterion(raw: string | null | undefined): string[] {
  if (raw === null || raw === undefined) return [];
  const text = String(raw).trim();
  if (text === "") return [];

  const found = new Set<string>();

  // 1. Any explicit N.N / N.N.N anywhere (bare, prefixed, suffixed, multi).
  for (const m of text.matchAll(SC_PATTERN)) {
    const [, a, b, c] = m;
    found.add(c !== undefined ? `${a}.${b}.${c}` : `${a}.${b}`);
  }

  // 2. Smushed `wcagNNN`.
  for (const m of text.matchAll(SMUSHED_PATTERN)) {
    const [, a, b, c] = m;
    found.add(`${a}.${b}.${c}`);
  }

  // 3. axe rule-id lookup (only when no numeric SC was found in this token, to
  //    avoid double-counting a string that already named its SC).
  if (found.size === 0) {
    const lower = text.toLowerCase();
    for (const [ruleId, scs] of Object.entries(AXE_RULE_TO_SC)) {
      if (lower === ruleId || lower.startsWith(`${ruleId}:`) || lower.startsWith(`${ruleId} `)) {
        for (const sc of scs) found.add(sc);
      }
    }
  }

  return [...found].sort(compareSC);
}

/** Numeric-aware SC comparator so "1.3.1" sorts before "1.3.10" before "2.1.1". */
export function compareSC(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}
