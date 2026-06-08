/**
 * The one bridge between axe-core's tag vocabulary and the corpus' WCAG SC keys.
 *
 * Pure — no browser, no playwright, no axe runtime. Lives apart from
 * `collect-dom.ts` so BOTH the live-DOM collector and the offline
 * baseline-catalog generator (`src/baseline/gen-baseline.ts`) read SCs off axe
 * tags through the EXACT same function. `collect-dom.ts` re-exports `scFromTags`
 * for back-compat, so existing imports keep working.
 */

/**
 * Read WCAG success criteria off axe-core's `tags`. axe tags an SC as
 * `wcag<principle><guideline><criterion>` with the dots removed — `wcag111` is
 * 1.1.1, `wcag244` is 2.4.4, `wcag1411` is 1.4.11. The principle and guideline
 * are always one digit; the criterion is the remainder (so 2-or-more-digit
 * criteria like `.11` round-trip). Conformance-level tags (`wcag2a`, `wcag21aa`)
 * and non-WCAG tags (`best-practice`, `cat.color`, `ACT`) carry letters and are
 * skipped. Deduped, original order preserved.
 *
 * This is the whole bridge between axe's vocabulary and the corpus: every
 * `enrichAll` lookup — and the baseline catalog — keys off these SC strings.
 */
export function scFromTags(tags: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tag of tags) {
    const m = /^wcag(\d)(\d)(\d+)$/.exec(tag);
    if (m === null) continue;
    const sc = `${m[1]}.${m[2]}.${m[3]}`;
    if (seen.has(sc)) continue;
    seen.add(sc);
    out.push(sc);
  }
  return out;
}
