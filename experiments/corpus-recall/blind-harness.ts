/**
 * Blind-grounding harness for the recall:eval certification (NOT shipped — a
 * one-shot experiment runner). It turns the labelled CASES into NEUTRAL per-item
 * bundles a blind agent can ground WITHOUT seeing the positive/negative label:
 * each bundle carries exactly what the production retrieve step hands the agent
 * (numbered source + corpusContext + suppressorMap + staticFindings) under an
 * opaque `item-NN` id. The id->caseId key is written separately and is NEVER
 * given to the grounding agents — only the scorer reads it.
 *
 *   pnpm exec tsx experiments/corpus-recall/blind-harness.ts build
 *     -> /tmp/recall-blind-bundles.json  (give THIS to the blind agents)
 *     -> /tmp/recall-blind-key.json      (secret id->caseId map, scorer only)
 *
 *   pnpm exec tsx experiments/corpus-recall/blind-harness.ts score
 *     -> reads /tmp/recall-noms-1.json .. -3.json (agent output, keyed by item id)
 *        maps each back to its caseId, runs the REAL runEval per pass, pools all
 *        surfaced findings across the 3 passes, and prints the pooled Wilson bound.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { CASES } from "./case-set";
import { type EvalReport, type Nominations, runEval, wilsonLowerBound } from "./eval";
import { type ReviewCandidate, reviewA11y } from "../../src/review";

const BUNDLES = "/tmp/recall-blind-bundles.json";
const KEY = "/tmp/recall-blind-key.json";

/** A neutral, label-free bundle the blind agent grounds from. */
interface BlindItem {
  readonly id: string; // item-NN — opaque, no positive/negative signal
  readonly source: readonly string[]; // 1-based numbered source lines
  readonly corpusContext: readonly {
    readonly patternId: string;
    readonly tier: string;
    readonly component: string;
    readonly failureShape: string;
    readonly fix: string;
    readonly eligibleToFlag: boolean;
  }[];
  readonly suppressorMap: Readonly<Record<number, readonly string[]>>;
  readonly staticFindings: readonly { readonly line: number; readonly ruleId: string; readonly wcag: readonly string[] }[];
}

/** Stable scramble so positives/negatives interleave and the order leaks nothing. */
function scrambleOrder<T extends { id: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) =>
    [...a.id].reverse().join("").localeCompare([...b.id].reverse().join("")),
  );
}

async function build(): Promise<void> {
  const ordered = scrambleOrder(CASES);
  const bundles: BlindItem[] = [];
  const key: Record<string, string> = {};

  for (let i = 0; i < ordered.length; i++) {
    const c = ordered[i]!;
    const itemId = `item-${String(i + 1).padStart(2, "0")}`;
    key[itemId] = c.id;

    const r = await reviewA11y({ files: [c.file] });
    if (r.mode !== "retrieve") throw new Error("expected retrieve mode");

    const abs = (await import("node:path")).resolve(c.file);
    const raw = readFileSync(c.file, "utf8").split("\n");
    // BLIND the source: the fixture author comments literally say "// POSITIVE:"
    // and name the expected patternId — that is the label. Blank every pure-comment
    // line (keeping line NUMBERS, since scoring runs on the original file, not this
    // text) so the agent sees only the code it must analyze, never the answer.
    const source = raw.map((l, idx) => {
      const isComment = l.trimStart().startsWith("//");
      return `${idx + 1}: ${isComment ? "" : l}`;
    });

    // suppressorMap / staticFindings are keyed by absolute path — strip to this file.
    const supRaw = r.suppressorMap[abs] ?? {};
    const suppressorMap: Record<number, readonly string[]> = {};
    for (const [line, names] of Object.entries(supRaw)) suppressorMap[Number(line)] = names;

    const staticFindings = r.staticFindings
      .filter((f) => (f.file === abs || f.file === c.file))
      .map((f) => ({ line: f.line, ruleId: f.ruleId, wcag: f.wcag }));

    bundles.push({
      id: itemId,
      source,
      corpusContext: r.corpusContext.map((p) => ({
        patternId: p.id,
        tier: p.tier,
        component: p.component,
        failureShape: p.failureShape,
        fix: p.fix,
        eligibleToFlag: p.eligibleToFlag,
      })),
      suppressorMap,
      staticFindings,
    });
  }

  writeFileSync(BUNDLES, JSON.stringify(bundles, null, 2));
  writeFileSync(KEY, JSON.stringify(key, null, 2));
  // eslint-disable-next-line no-console
  console.log(`wrote ${bundles.length} bundles -> ${BUNDLES}\nwrote key -> ${KEY}`);
}

/** Map one pass's item-keyed nominations back to caseId-keyed Nominations. */
function remap(
  passNoms: Record<string, Omit<ReviewCandidate, "file">[]>,
  key: Record<string, string>,
): { noms: Nominations; caseFile: Map<string, string> } {
  const caseFile = new Map(CASES.map((c) => [c.id, c.file]));
  const noms: Record<string, ReviewCandidate[]> = {};
  for (const [itemId, cands] of Object.entries(passNoms)) {
    const caseId = key[itemId];
    if (caseId === undefined) continue;
    const file = caseFile.get(caseId);
    if (file === undefined) continue;
    noms[caseId] = cands.map((c) => ({ ...c, file }));
  }
  return { noms, caseFile };
}

async function score(): Promise<void> {
  const key = JSON.parse(readFileSync(KEY, "utf8")) as Record<string, string>;
  const passes = [1, 2, 3]
    .map((n) => `/tmp/recall-noms-${n}.json`)
    .filter((p) => {
      try {
        readFileSync(p);
        return true;
      } catch {
        return false;
      }
    });

  let pooledSurfaced = 0;
  let pooledCorrect = 0;
  const perPass: { pass: string; report: EvalReport }[] = [];

  for (const p of passes) {
    const passNoms = JSON.parse(readFileSync(p, "utf8")) as Record<
      string,
      Omit<ReviewCandidate, "file">[]
    >;
    const { noms } = remap(passNoms, key);
    const report = await runEval(noms);
    perPass.push({ pass: p, report });
    pooledSurfaced += report.surfacedTotal;
    pooledCorrect += report.surfacedCorrect;
  }

  const pooledWilson = wilsonLowerBound(pooledCorrect, pooledSurfaced);
  // eslint-disable-next-line no-console
  console.log("\n=== per-pass ===");
  for (const { pass, report } of perPass) {
    // eslint-disable-next-line no-console
    console.log(
      `${pass}: surfaced ${report.surfacedCorrect}/${report.surfacedTotal} correct, ` +
        `recall ${report.caughtTotal}/${report.expectedTotal}, Wilson ${report.precisionWilsonLower.toFixed(3)}`,
    );
    // Surface any FP for diagnosis (a surfaced finding that wasn't correct).
    for (const cs of report.cases) {
      const fps = cs.surfaced.filter((s) => !s.correct);
      if (fps.length > 0) {
        // eslint-disable-next-line no-console
        console.log(`   FP @ ${cs.id}: ${fps.map((f) => `${f.patternId}:${f.line}`).join(", ")}`);
      }
    }
  }
  // eslint-disable-next-line no-console
  console.log("\n=== POOLED (3 passes) ===");
  // eslint-disable-next-line no-console
  console.log(`surfaced correct: ${pooledCorrect}/${pooledSurfaced}`);
  // eslint-disable-next-line no-console
  console.log(`precision Wilson lower bound: ${pooledWilson.toFixed(4)}`);
  // eslint-disable-next-line no-console
  console.log(`gate (>= 0.95): ${pooledWilson >= 0.95 ? "PASS ✅" : "FAIL ❌"}`);
}

const mode = process.argv[2];
if (mode === "build") build().catch((e: unknown) => { console.error(e); process.exitCode = 1; });
else if (mode === "score") score().catch((e: unknown) => { console.error(e); process.exitCode = 1; });
else {
  // eslint-disable-next-line no-console
  console.error("usage: blind-harness.ts build | score");
  process.exitCode = 1;
}
