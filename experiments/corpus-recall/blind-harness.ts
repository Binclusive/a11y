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
 *
 * The committed certificate (`certification/`) is re-scored deterministically by
 * `test/recall-certification.test.ts` via the exported {@link deriveKey} +
 * {@link scoreArtifacts} — no model is needed to enforce it in `pnpm test`.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { corpusPatterns } from "../../src/corpus";
import { type ReviewCandidate, reviewA11y } from "../../src/review";
import { CASES } from "./case-set";
import { type Nominations, runEval, wilsonLowerBound } from "./eval";

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

/** Per-pass scoring outcome, derived purely from the EvalReport for one pass. */
export interface PassScore {
  readonly surfacedCorrect: number;
  readonly surfacedTotal: number;
  readonly wilson: number;
  readonly caught: number;
  readonly expected: number;
  readonly fps: { caseId: string; patternId: string; line: number }[];
  readonly decoyLeaks: { caseId: string; patternId: string; line: number }[];
  readonly dropped: string[];
}

/** The pooled certificate across all passes — what the gate reads. */
export interface PooledScore {
  readonly perPass: PassScore[];
  readonly pooledCorrect: number;
  readonly pooledTotal: number;
  readonly pooledWilson: number;
  readonly totalDropped: string[];
  readonly totalDecoyLeaks: number;
  readonly pass: boolean;
}

/** Stable scramble so positives/negatives interleave and the order leaks nothing. */
function scrambleOrder<T extends { id: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) =>
    [...a.id].reverse().join("").localeCompare([...b.id].reverse().join("")),
  );
}

/**
 * The deterministic item-NN -> caseId key for the CURRENT CASES. SINGLE SOURCE OF
 * TRUTH: `build()` writes exactly this, and the certification test asserts the
 * committed `key.json` equals this — so the committed artifacts can never silently
 * go stale when CASES drifts (a reorder/add/remove moves the derived key).
 */
export function deriveKey(): Record<string, string> {
  const ordered = scrambleOrder(CASES);
  const key: Record<string, string> = {};
  for (let i = 0; i < ordered.length; i++) {
    const c = ordered[i]!;
    key[`item-${String(i + 1).padStart(2, "0")}`] = c.id;
  }
  return key;
}

async function build(): Promise<void> {
  const ordered = scrambleOrder(CASES);
  const key = deriveKey();
  const bundles: BlindItem[] = [];

  // The set of tokens whose presence in a bundle's SOURCE would leak the label.
  // We check ONLY `bundle.source` (the code the agent reads) — patternIds legitimately
  // appear in corpusContext, which is the vocabulary the agent picks from.
  const forbidden = new Set<string>([
    "POSITIVE",
    "NEGATIVE",
    ...corpusPatterns().map((p) => p.id),
    ...CASES.map((c) => c.id),
    ...CASES.map((c) => c.file.split("/").pop()!.replace(/\.tsx$/, "")),
  ]);

  for (let i = 0; i < ordered.length; i++) {
    const c = ordered[i]!;
    const itemId = `item-${String(i + 1).padStart(2, "0")}`;

    const r = await reviewA11y({ files: [c.file] });
    if (r.mode !== "retrieve") throw new Error("expected retrieve mode");

    const abs = resolve(c.file);
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

    const bundle: BlindItem = {
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
    };

    // Assert the SOURCE the agent reads leaks no label token. Match the token as a
    // whole identifier (not bordered by `-` or a word char) so an import of a
    // sibling `<case>-def.tsx` def file — a structural necessity of the resolved-host
    // negatives, carrying no positive/negative signal — is not a false leak.
    const src = bundle.source.join("\n");
    for (const tok of forbidden) {
      const re = new RegExp(`(?<![\\w-])${tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`);
      if (re.test(src)) throw new Error(`bundle ${bundle.id} leaks label token "${tok}"`);
    }

    bundles.push(bundle);
  }

  writeFileSync(BUNDLES, JSON.stringify(bundles, null, 2));
  writeFileSync(KEY, JSON.stringify(key, null, 2));
  // eslint-disable-next-line no-console
  console.log(`wrote ${bundles.length} bundles -> ${BUNDLES}\nwrote key -> ${KEY}`);
}

/**
 * Map one pass's item-keyed nominations back to caseId-keyed Nominations. Any
 * itemId whose `key[itemId]` is undefined (a stale artifact), or whose case file
 * is missing, is COLLECTED onto `dropped` — never silently skipped, so a drift
 * between the committed artifacts and the current CASES is visible in the score.
 */
function remap(
  passNoms: Record<string, Omit<ReviewCandidate, "file">[]>,
  key: Record<string, string>,
): { noms: Nominations; dropped: string[] } {
  const caseFile = new Map(CASES.map((c) => [c.id, c.file]));
  const noms: Record<string, ReviewCandidate[]> = {};
  const dropped: string[] = [];
  for (const [itemId, cands] of Object.entries(passNoms)) {
    const caseId = key[itemId];
    if (caseId === undefined) {
      dropped.push(itemId);
      continue;
    }
    const file = caseFile.get(caseId);
    if (file === undefined) {
      dropped.push(itemId);
      continue;
    }
    noms[caseId] = cands.map((c) => ({ ...c, file }));
  }
  return { noms, dropped };
}

/**
 * Pure scorer over the committed/captured artifacts: given the id->case key and a
 * list of per-pass item-keyed nomination maps, remap each pass back to caseIds, run
 * the REAL `runEval`, and pool the surfaced findings across passes for ONE Wilson
 * lower bound. This is what `test/recall-certification.test.ts` calls to enforce
 * the committed certificate deterministically — no model in the loop.
 */
export async function scoreArtifacts(
  key: Record<string, string>,
  passNomsList: Record<string, Omit<ReviewCandidate, "file">[]>[],
): Promise<PooledScore> {
  // Which cases are NEGATIVES — any surfaced finding on one is a decoy leak.
  const kindById = new Map(CASES.map((c) => [c.id, c.kind]));

  const perPass: PassScore[] = [];
  let pooledCorrect = 0;
  let pooledTotal = 0;
  const totalDropped: string[] = [];

  for (const passNoms of passNomsList) {
    const { noms, dropped } = remap(passNoms, key);
    totalDropped.push(...dropped);
    const report = await runEval(noms);

    const fps: { caseId: string; patternId: string; line: number }[] = [];
    const decoyLeaks: { caseId: string; patternId: string; line: number }[] = [];
    for (const cs of report.cases) {
      for (const s of cs.surfaced) {
        if (!s.correct) fps.push({ caseId: cs.id, patternId: s.patternId, line: s.line });
        if (kindById.get(cs.id) === "negative") {
          decoyLeaks.push({ caseId: cs.id, patternId: s.patternId, line: s.line });
        }
      }
    }

    perPass.push({
      surfacedCorrect: report.surfacedCorrect,
      surfacedTotal: report.surfacedTotal,
      wilson: report.precisionWilsonLower,
      caught: report.caughtTotal,
      expected: report.expectedTotal,
      fps,
      decoyLeaks,
      dropped,
    });
    pooledCorrect += report.surfacedCorrect;
    pooledTotal += report.surfacedTotal;
  }

  const pooledWilson = wilsonLowerBound(pooledCorrect, pooledTotal);
  const totalDecoyLeaks = perPass.reduce((n, p) => n + p.decoyLeaks.length, 0);
  return {
    perPass,
    pooledCorrect,
    pooledTotal,
    pooledWilson,
    totalDropped,
    totalDecoyLeaks,
    pass: pooledWilson >= 0.95,
  };
}

async function score(): Promise<void> {
  const key = JSON.parse(readFileSync(KEY, "utf8")) as Record<string, string>;
  const passNomsList = [1, 2, 3]
    .map((n) => `/tmp/recall-noms-${n}.json`)
    .filter((p) => existsSync(p))
    .map(
      (p) =>
        JSON.parse(readFileSync(p, "utf8")) as Record<string, Omit<ReviewCandidate, "file">[]>,
    );

  const r = await scoreArtifacts(key, passNomsList);

  // eslint-disable-next-line no-console
  console.log("\n=== per-pass ===");
  r.perPass.forEach((p, i) => {
    // eslint-disable-next-line no-console
    console.log(
      `pass ${i + 1}: surfaced ${p.surfacedCorrect}/${p.surfacedTotal} correct, ` +
        `recall ${p.caught}/${p.expected}, Wilson ${p.wilson.toFixed(3)}`,
    );
    for (const fp of p.fps) {
      // eslint-disable-next-line no-console
      console.log(`   FP @ ${fp.caseId}: ${fp.patternId}:${fp.line}`);
    }
  });

  // eslint-disable-next-line no-console
  console.log("\n=== POOLED (3 passes) ===");
  // eslint-disable-next-line no-console
  console.log(`surfaced correct: ${r.pooledCorrect}/${r.pooledTotal}`);
  // eslint-disable-next-line no-console
  console.log(`precision Wilson lower bound: ${r.pooledWilson.toFixed(4)}`);
  // eslint-disable-next-line no-console
  console.log(
    "note: 3 correlated passes — pooled lower bound under correlation, not 78 i.i.d. samples",
  );
  if (r.totalDropped.length > 0) {
    // eslint-disable-next-line no-console
    console.log(`dropped item-ids (no case / stale key): ${r.totalDropped.join(", ")}`);
  }
  if (r.totalDecoyLeaks > 0) {
    // eslint-disable-next-line no-console
    console.log(`DECOY LEAKS: ${r.totalDecoyLeaks} surfaced findings on negative cases`);
  }
  // eslint-disable-next-line no-console
  console.log(`gate (>= 0.95): ${r.pass ? "PASS ✅" : "FAIL ❌"}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const mode = process.argv[2];
  if (mode === "build") build().catch((e: unknown) => { console.error(e); process.exitCode = 1; });
  else if (mode === "score") score().catch((e: unknown) => { console.error(e); process.exitCode = 1; });
  else {
    // eslint-disable-next-line no-console
    console.error("usage: blind-harness.ts build | score");
    process.exitCode = 1;
  }
}
