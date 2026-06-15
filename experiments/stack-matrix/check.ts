/**
 * check.ts — `matrix:check`: the real-world regression gate.
 *
 * Re-scans the SHA-pinned corpus with the CURRENT checker, diffs the result
 * against the committed baseline.json, prints every repo whose numbers moved,
 * and exits non-zero if anything did. Run it before opening a PR that touches
 * the resolver or enforce rules.
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
  if (d.checked) {
    const delta = d.checked.after - d.checked.before;
    bits.push(`coverage.checked ${d.checked.before}→${d.checked.after} (${delta > 0 ? "+" : ""}${delta})`);
  }
  return `~ ${repo} ${bits.join("  ")}${fmtRules(d)}`;
}

function main() {
  const skipRun = process.argv.includes("--no-run");

  const baseline = loadBaseline();
  if (baseline === null) {
    console.error("No baseline.json found. Create one with `pnpm matrix:baseline` first.");
    process.exit(1);
  }

  if (!skipRun) {
    console.log("Re-scanning pinned corpus (this clones/scans every repo — minutes)…\n");
    runAll();
    console.log("");
  }

  const current = toBaseline(loadResults());
  const { deltas, unchanged } = diffBaseline(current, baseline);

  if (deltas.length === 0) {
    console.log(`✓ corpus unchanged — ${unchanged} repos match baseline.`);
    process.exit(0);
  }

  console.log(`Real-world deltas vs baseline (${unchanged} unchanged, ${deltas.length} moved):\n`);
  for (const d of deltas) console.log(fmtDelta(d));
  console.log(
    `\n✗ ${deltas.length} repo(s) moved. If intended, re-bless with \`pnpm matrix:baseline\`` +
      ` and commit baseline.json with your change.`,
  );
  process.exit(1);
}

main();
