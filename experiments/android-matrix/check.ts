/**
 * check.ts — `android:matrix:check`: the Android real-world regression gate.
 *
 * Re-scans the SHA-pinned Android corpus with the CURRENT Android checker
 * (`src/collect-android-xml.ts`), diffs the result against the committed
 * baseline.json, prints every repo whose numbers moved, and exits non-zero if
 * anything did. Run it before opening a PR that touches the Android path.
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

import { diffBaseline, loadBaseline, loadResults, type RepoDelta, toBaseline } from "./baseline.ts";
import { runAll } from "./run.ts";

function fmtRules(d: RepoDelta): string {
  if (d.rules.length === 0) return "";
  const parts = d.rules.map((r) => {
    const delta = r.after - r.before;
    return `${r.ruleId} ${delta > 0 ? "+" : ""}${delta}`;
  });
  return `  [${parts.join(", ")}]`;
}

function fmtDelta(d: RepoDelta): string {
  if (d.kind === "added") return `+ ${d.repo} NEW (${d.findings?.after ?? 0} findings)`;
  if (d.kind === "removed") return `- ${d.repo} REMOVED (was ${d.findings?.before ?? 0} findings)`;

  const bits: string[] = [];
  const span = (label: string, m: { before: number; after: number }) => {
    const delta = m.after - m.before;
    bits.push(`${label} ${m.before}→${m.after} (${delta > 0 ? "+" : ""}${delta})`);
  };
  if (d.findings) span("findings", d.findings);
  if (d.files) span("files", d.files);
  if (d.parseErrors) span("parseErrors", d.parseErrors);
  if (d.errorChange) {
    bits.push(`error ${JSON.stringify(d.errorChange.before)}→${JSON.stringify(d.errorChange.after)}`);
  }
  return `~ ${d.repo} ${bits.join("  ")}${fmtRules(d)}`;
}

async function main(): Promise<void> {
  const skipRun = process.argv.includes("--no-run");

  const baseline = loadBaseline();
  if (baseline === null) {
    console.error("No baseline.json found. Create one with `pnpm android:matrix:baseline` first.");
    process.exit(1);
  }

  if (!skipRun) {
    console.log("Re-scanning pinned Android corpus (clones + scans each repo — minutes)…\n");
    await runAll();
    console.log("");
  }

  const raw = loadResults();

  // Pin integrity: a repo that fell back to a floating branch clone (fetch-by-sha
  // refused) is no longer frozen at its manifest sha — its delta may be upstream
  // drift, not your change. Surface it; do not let it pass silently as a code
  // regression.
  const unpinned = Object.values(raw)
    .filter((r) => r.pinned === false && !r.error)
    .map((r) => r.repo);
  if (unpinned.length > 0) {
    console.log(
      `⚠ ${unpinned.length} repo(s) NOT pinned to manifest sha — their deltas may reflect ` +
        `upstream drift, not your change: ${unpinned.join(", ")}\n`,
    );
  }

  const current = toBaseline(raw);
  const { deltas, unchanged } = diffBaseline(current, baseline);

  if (deltas.length === 0) {
    console.log(`✓ corpus unchanged — ${unchanged} repo(s) match baseline.`);
    process.exit(0);
  }

  console.log(`Real-world Android deltas vs baseline (${unchanged} unchanged, ${deltas.length} moved):\n`);
  for (const d of deltas) console.log(fmtDelta(d));
  console.log(
    `\n✗ ${deltas.length} repo(s) moved. If intended, re-bless with ` +
      `\`pnpm android:matrix:baseline\` and commit baseline.json with your change.`,
  );
  process.exit(1);
}

main();
