/**
 * check.ts — `compose:matrix:check`: the Compose real-world regression gate.
 *
 * Re-scans the SHA-pinned Compose corpus with the CURRENT checker, diffs the result
 * against the committed baseline.json, prints every repo whose numbers moved, and
 * exits non-zero if anything did. Run it before opening a PR that touches the
 * Compose path — the TS boundary (`src/collect-kotlin.ts`) OR the out-of-process
 * Kotlin PSI engine (`kotlin/A11yKotlinScan/`, rule `compose/image-no-label`). The
 * engine must be built before this runs (`./gradlew installDist` — see README). The
 * re-scan / diff / exit-code driver is shared (`experiments/_matrix/harness.ts`, #247).
 *
 * A non-zero exit is NOT "your change is wrong" — it is "your change moved
 * real-world Compose behavior, look at the delta." If the movement is intended (the
 * rule now catches a real unlabeled Compose image, say), re-bless with
 * `pnpm compose:matrix:baseline` and commit the updated baseline.json alongside your
 * change, so the shift is visible in review.
 *
 * Flags:
 *   --no-run   diff the EXISTING results/ against baseline (skip the clone+scan)
 *              — useful for re-reading a delta without re-cloning.
 */

import { fmtRules, runCheck, type SnapshotDelta } from "../_matrix/harness.ts";
import { diffBaseline, loadBaseline, loadResults, toBaseline, writeBaseline } from "./baseline.ts";
import { runAll } from "./run.ts";

function fmtDelta(d: SnapshotDelta): string {
  if (d.kind === "added") return `+ ${d.repo} NEW (${d.findings?.after ?? 0} findings)`;
  if (d.kind === "removed") return `- ${d.repo} REMOVED (was ${d.findings?.before ?? 0} findings)`;

  const bits: string[] = [];
  if (d.findings) {
    const delta = d.findings.after - d.findings.before;
    bits.push(`findings ${d.findings.before}→${d.findings.after} (${delta > 0 ? "+" : ""}${delta})`);
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
    noBaseline: "No baseline.json found. Create one with `pnpm compose:matrix:baseline` first.",
    rescan: "Re-scanning pinned Compose corpus (clones + scans each repo — minutes)…\n",
    pinNoun: "repo(s)",
    unchanged: (unchanged) => `✓ corpus unchanged — ${unchanged} repo(s) match baseline.`,
    header: (unchanged, moved) => `Real-world Compose deltas vs baseline (${unchanged} unchanged, ${moved} moved):\n`,
    footer: (moved) =>
      `\n✗ ${moved} repo(s) moved. If intended, re-bless with ` +
      `\`pnpm compose:matrix:baseline\` and commit baseline.json with your change.`,
  },
});
