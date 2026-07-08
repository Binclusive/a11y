/**
 * check.ts — `android:matrix:check`: the Android real-world regression gate.
 *
 * Re-scans the SHA-pinned Android corpus with the CURRENT Android checker
 * (`src/collect-android-xml.ts`), diffs the result against the committed
 * baseline.json, prints every repo whose numbers moved, and exits non-zero if
 * anything did. Run it before opening a PR that touches the Android path. The
 * re-scan / diff / exit-code driver is shared (`experiments/_matrix/harness.ts`,
 * #247); this dir owns only its per-repo delta formatting.
 *
 * A non-zero exit is NOT "your change is wrong" — it is "your change moved
 * real-world Android behavior, look at the delta." If the movement is intended (a
 * rule now catches a real layout bug, say), re-bless with
 * `pnpm android:matrix:baseline` and commit the updated baseline.json alongside
 * your change, so the shift is visible in review.
 *
 * Flags:
 *   --no-run   diff the EXISTING results/ against baseline (skip the clone+scan)
 *              — useful for re-reading a delta without re-cloning.
 */

import { fmtRules, mv, runCheck, type SnapshotDelta } from "../_matrix/harness.ts";
import { diffBaseline, loadBaseline, loadResults, toBaseline, writeBaseline } from "./baseline.ts";
import { runAll } from "./run.ts";

function fmtDelta(d: SnapshotDelta): string {
  if (d.kind === "added") return `+ ${d.repo} NEW (${d.findings?.after ?? 0} findings)`;
  if (d.kind === "removed") return `- ${d.repo} REMOVED (was ${d.findings?.before ?? 0} findings)`;

  const bits: string[] = [];
  const span = (label: string, m: { before: number; after: number }) => {
    const delta = m.after - m.before;
    bits.push(`${label} ${m.before}→${m.after} (${delta > 0 ? "+" : ""}${delta})`);
  };
  const files = mv(d, "files");
  const parseErrors = mv(d, "parseErrors");
  if (d.findings) span("findings", d.findings);
  if (files) span("files", files);
  if (parseErrors) span("parseErrors", parseErrors);
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
    noBaseline: "No baseline.json found. Create one with `pnpm android:matrix:baseline` first.",
    rescan: "Re-scanning pinned Android corpus (clones + scans each repo — minutes)…\n",
    pinNoun: "repo(s)",
    unchanged: (unchanged) => `✓ corpus unchanged — ${unchanged} repo(s) match baseline.`,
    header: (unchanged, moved) => `Real-world Android deltas vs baseline (${unchanged} unchanged, ${moved} moved):\n`,
    footer: (moved) =>
      `\n✗ ${moved} repo(s) moved. If intended, re-bless with ` +
      `\`pnpm android:matrix:baseline\` and commit baseline.json with your change.`,
  },
});
