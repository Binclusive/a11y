/**
 * check.ts — `unity:matrix:check`: the Unity real-world regression gate.
 *
 * Re-scans the SHA-pinned Unity corpus with the CURRENT Unity producer, diffs the
 * result against the committed baseline.json, prints every repo whose numbers
 * moved, and exits non-zero if anything did. Run it before opening a PR that
 * touches the Unity path (L1 `unity-ast.ts`, L3 `collect-unity.ts`, or
 * `unity-guid-registry.ts`).
 *
 * A non-zero exit is NOT "your change is wrong" — it is "your change moved
 * real-world Unity behavior, look at the delta." If the movement is intended (a
 * rule now parses an asset that used to be opaque, say), re-bless with
 * `pnpm unity:matrix:baseline` and commit the updated baseline.json alongside
 * your change, so the shift is visible in review.
 *
 * Flags:
 *   --no-run   diff the EXISTING results/ against baseline (skip the clone+scan)
 *              — useful for re-reading a delta without re-cloning.
 */

import { diffBaseline, loadBaseline, loadResults, type RepoDelta, toBaseline } from "./baseline.ts";
import { runAll } from "./run.ts";

function fmtDelta(d: RepoDelta): string {
  if (d.kind === "added") return `+ ${d.repo} NEW (${d.assets?.after ?? 0} assets)`;
  if (d.kind === "removed") return `- ${d.repo} REMOVED (was ${d.assets?.before ?? 0} assets)`;

  const bits: string[] = [];
  const span = (label: string, m: { before: number; after: number }) => {
    const delta = m.after - m.before;
    bits.push(`${label} ${m.before}→${m.after} (${delta > 0 ? "+" : ""}${delta})`);
  };
  if (d.assets) span("assets", d.assets);
  if (d.graph) span("graph", d.graph);
  if (d.opaqueBinary) span("opaque(binary)", d.opaqueBinary);
  if (d.opaqueParseError) span("opaque(parse)", d.opaqueParseError);
  if (d.errorChange) {
    bits.push(`error ${JSON.stringify(d.errorChange.before)}→${JSON.stringify(d.errorChange.after)}`);
  }
  return `~ ${d.repo} ${bits.join("  ")}`;
}

async function main(): Promise<void> {
  const skipRun = process.argv.includes("--no-run");

  const baseline = loadBaseline();
  if (baseline === null) {
    console.error("No baseline.json found. Create one with `pnpm unity:matrix:baseline` first.");
    process.exit(1);
  }

  if (!skipRun) {
    console.log("Re-scanning pinned Unity corpus (clones + scans each repo — minutes)…\n");
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

  console.log(`Real-world Unity deltas vs baseline (${unchanged} unchanged, ${deltas.length} moved):\n`);
  for (const d of deltas) console.log(fmtDelta(d));
  console.log(
    `\n✗ ${deltas.length} repo(s) moved. If intended, re-bless with ` +
      `\`pnpm unity:matrix:baseline\` and commit baseline.json with your change.`,
  );
  process.exit(1);
}

main();
