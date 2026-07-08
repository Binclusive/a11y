/**
 * check.ts — `matrix:check`: the real-world regression gate.
 *
 * Re-scans the SHA-pinned corpus with the CURRENT checker, diffs the result
 * against the committed baseline.json, prints every repo whose numbers moved,
 * and exits non-zero if anything did. Run it before opening a PR that touches
 * the resolver or enforce rules. The re-scan / diff / exit-code driver is shared
 * (`experiments/_matrix/harness.ts`, #247); this dir owns only its delta formatting.
 *
 * A non-zero exit is NOT "your change is wrong" — it is "your change moved
 * real-world behavior, look at the delta." If the movement is intended (you now
 * catch a real bug), re-bless with `pnpm matrix:baseline` and commit the updated
 * baseline.json alongside your change, so the shift is visible in review.
 *
 * Flags:
 *   --no-run   diff the EXISTING results/ against baseline (skip the ~minutes
 *              re-scan) — useful for re-reading a diff without re-cloning.
 */

import { fmtRules, mv, runCheck, type SnapshotDelta } from "../_matrix/harness.ts";
import { diffBaseline, loadBaseline, loadResults, toBaseline, writeBaseline } from "./baseline.ts";
import { runAll } from "./run.ts";

function fmtDelta(d: SnapshotDelta): string {
  const repo = d.repo.padEnd(38);
  if (d.kind === "added") return `+ ${repo} NEW in corpus (${d.findings?.after ?? 0} findings)`;
  if (d.kind === "removed") return `- ${repo} REMOVED from corpus`;

  const bits: string[] = [];
  if (d.errorChange) {
    const { before, after } = d.errorChange;
    if (!before && after) bits.push(`now ERRORS: ${after}`);
    else if (before && !after) bits.push("error CLEARED");
    else bits.push(`error changed: ${after}`);
  }
  if (d.findings) {
    const delta = d.findings.after - d.findings.before;
    bits.push(`findings ${d.findings.before}→${d.findings.after} (${delta > 0 ? "+" : ""}${delta})`);
  }
  const checked = mv(d, "checked");
  if (checked) {
    const delta = checked.after - checked.before;
    bits.push(`coverage.checked ${checked.before}→${checked.after} (${delta > 0 ? "+" : ""}${delta})`);
  }
  return `~ ${repo} ${bits.join("  ")}${fmtRules(d)}`;
}

runCheck({
  argv: process.argv,
  runAll,
  store: { loadResults, loadBaseline, writeBaseline, toBaseline },
  diff: diffBaseline,
  fmtDelta,
  messages: {
    noBaseline: "No baseline.json found. Create one with `pnpm matrix:baseline` first.",
    rescan: "Re-scanning pinned corpus (this clones/scans every repo — minutes)…\n",
    pinNoun: "repo(s)",
    unchanged: (unchanged) => `✓ corpus unchanged — ${unchanged} repos match baseline.`,
    header: (unchanged, moved) => `Real-world deltas vs baseline (${unchanged} unchanged, ${moved} moved):\n`,
    footer: (moved) =>
      `\n✗ ${moved} repo(s) moved. If intended, re-bless with \`pnpm matrix:baseline\`` +
      ` and commit baseline.json with your change.`,
  },
});
