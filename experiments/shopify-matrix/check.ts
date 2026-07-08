/**
 * check.ts — `shopify:matrix:check`: the Liquid real-world regression gate.
 *
 * Re-scans the SHA-pinned Shopify-theme corpus with the CURRENT Liquid checker,
 * diffs the result against the committed baseline.json, prints every theme whose
 * numbers moved, and exits non-zero if anything did. Run it before opening a PR
 * that touches the Liquid path (L1 `liquid-ast.ts`, L2 `liquid-rules.ts`, or
 * `collect-liquid.ts`). The re-scan / diff / exit-code driver is shared
 * (`experiments/_matrix/harness.ts`, #247).
 *
 * A non-zero exit is NOT "your change is wrong" — it is "your change moved
 * real-world Liquid behavior, look at the delta." If the movement is intended
 * (you now catch a real theme bug), re-bless with `pnpm shopify:matrix:baseline`
 * and commit the updated baseline.json alongside your change, so the shift is
 * visible in review.
 *
 * Flags:
 *   --no-run   diff the EXISTING results/ against baseline (skip the re-scan) —
 *              useful for re-reading a diff without re-cloning.
 */

import { fmtRules, mv, runCheck, type SnapshotDelta } from "../_matrix/harness.ts";
import { diffBaseline, loadBaseline, loadResults, toBaseline, writeBaseline } from "./baseline.ts";
import { runAll } from "./run.ts";

function fmtDelta(d: SnapshotDelta): string {
  if (d.kind === "added") return `+ ${d.repo} NEW (${d.findings?.after ?? 0} findings)`;
  if (d.kind === "removed") return `- ${d.repo} REMOVED (was ${d.findings?.before ?? 0} findings)`;

  const bits: string[] = [];
  const files = mv(d, "files");
  const parseErrors = mv(d, "parseErrors");
  if (d.findings) {
    const delta = d.findings.after - d.findings.before;
    bits.push(`findings ${d.findings.before}→${d.findings.after} (${delta > 0 ? "+" : ""}${delta})`);
  }
  if (files) {
    const delta = files.after - files.before;
    bits.push(`files ${files.before}→${files.after} (${delta > 0 ? "+" : ""}${delta})`);
  }
  if (parseErrors) {
    const delta = parseErrors.after - parseErrors.before;
    bits.push(`parseErrors ${parseErrors.before}→${parseErrors.after} (${delta > 0 ? "+" : ""}${delta})`);
  }
  if (d.errorChange) {
    bits.push(`error ${JSON.stringify(d.errorChange.before)}→${JSON.stringify(d.errorChange.after)}`);
  }
  return `~ ${d.repo} ${bits.join("  ")}${fmtRules(d)}`;
}

runCheck({
  argv: process.argv,
  runAll,
  store: { loadResults, loadBaseline, writeBaseline, toBaseline },
  diff: diffBaseline,
  fmtDelta,
  messages: {
    noBaseline: "No baseline.json found. Create one with `pnpm shopify:matrix:baseline` first.",
    rescan: "Re-scanning pinned Shopify-theme corpus (clones + scans each theme)…\n",
    pinNoun: "theme(s)",
    unchanged: (unchanged) => `✓ corpus unchanged — ${unchanged} theme(s) match baseline.`,
    header: (unchanged, moved) => `Real-world Liquid deltas vs baseline (${unchanged} unchanged, ${moved} moved):\n`,
    footer: (moved) =>
      `\n✗ ${moved} theme(s) moved. If intended, re-bless with ` +
      `\`pnpm shopify:matrix:baseline\` and commit baseline.json with your change.`,
  },
});
