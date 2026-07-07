/**
 * check.ts — `shopify:matrix:check`: the Liquid real-world regression gate.
 *
 * Re-scans the SHA-pinned Shopify-theme corpus with the CURRENT Liquid checker,
 * diffs the result against the committed baseline.json, prints every theme whose
 * numbers moved, and exits non-zero if anything did. Run it before opening a PR
 * that touches the Liquid path (L1 `liquid-ast.ts`, L2 `liquid-rules.ts`, or
 * `collect-liquid.ts`).
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

import { diffBaseline, loadBaseline, loadResults, type ThemeDelta, toBaseline } from "./baseline.ts";
import { runAll } from "./run.ts";

function fmtRules(d: ThemeDelta): string {
  if (d.rules.length === 0) return "";
  const parts = d.rules.map((r) => {
    const delta = r.after - r.before;
    return `${r.ruleId} ${delta > 0 ? "+" : ""}${delta}`;
  });
  return `  [${parts.join(", ")}]`;
}

function fmtDelta(d: ThemeDelta): string {
  if (d.kind === "added") return `+ ${d.repo} NEW (${d.findings?.after ?? 0} findings)`;
  if (d.kind === "removed") return `- ${d.repo} REMOVED (was ${d.findings?.before ?? 0} findings)`;

  const bits: string[] = [];
  if (d.findings) {
    const delta = d.findings.after - d.findings.before;
    bits.push(`findings ${d.findings.before}→${d.findings.after} (${delta > 0 ? "+" : ""}${delta})`);
  }
  if (d.files) {
    const delta = d.files.after - d.files.before;
    bits.push(`files ${d.files.before}→${d.files.after} (${delta > 0 ? "+" : ""}${delta})`);
  }
  if (d.parseErrors) {
    const delta = d.parseErrors.after - d.parseErrors.before;
    bits.push(`parseErrors ${d.parseErrors.before}→${d.parseErrors.after} (${delta > 0 ? "+" : ""}${delta})`);
  }
  if (d.errorChange) {
    bits.push(`error ${JSON.stringify(d.errorChange.before)}→${JSON.stringify(d.errorChange.after)}`);
  }
  return `~ ${d.repo} ${bits.join("  ")}${fmtRules(d)}`;
}

async function main(): Promise<void> {
  const skipRun = process.argv.includes("--no-run");

  const baseline = loadBaseline();
  if (baseline === null) {
    console.error("No baseline.json found. Create one with `pnpm shopify:matrix:baseline` first.");
    process.exit(1);
  }

  if (!skipRun) {
    console.log("Re-scanning pinned Shopify-theme corpus (clones + scans each theme)…\n");
    await runAll();
    console.log("");
  }

  const raw = loadResults();

  // Pin integrity: a theme that fell back to a floating branch clone (fetch-by-sha
  // refused) is no longer frozen — its delta may be upstream drift, not your change.
  const unpinned = Object.values(raw)
    .filter((r) => r.pinned === false && !r.error)
    .map((r) => r.repo);
  if (unpinned.length > 0) {
    console.log(
      `⚠ ${unpinned.length} theme(s) NOT pinned to manifest sha — their deltas may reflect ` +
        `upstream drift, not your change: ${unpinned.join(", ")}\n`,
    );
  }

  const current = toBaseline(raw);
  const { deltas, unchanged } = diffBaseline(current, baseline);

  if (deltas.length === 0) {
    console.log(`✓ corpus unchanged — ${unchanged} theme(s) match baseline.`);
    process.exit(0);
  }

  console.log(`Real-world Liquid deltas vs baseline (${unchanged} unchanged, ${deltas.length} moved):\n`);
  for (const d of deltas) console.log(fmtDelta(d));
  console.log(
    `\n✗ ${deltas.length} theme(s) moved. If intended, re-bless with ` +
      `\`pnpm shopify:matrix:baseline\` and commit baseline.json with your change.`,
  );
  process.exit(1);
}

main();
