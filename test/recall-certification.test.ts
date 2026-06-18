import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ReviewCandidate } from "../src/review";
import { corpusPatterns } from "../src/corpus";
import { CERTIFIED_RECALL_PATTERN_IDS } from "../src/retrieve";
import { CASES } from "../experiments/corpus-recall/case-set";
import {
  deriveKey,
  scoreArtifacts,
} from "../experiments/corpus-recall/blind-harness";

/**
 * THE GATE. This re-scores the COMMITTED blind-grounded certificate
 * (`experiments/corpus-recall/certification/`) deterministically inside
 * `pnpm test` — no model is called. The three blind passes' nominations flow
 * through the EXACT shipped verify path (`scoreArtifacts` -> `runEval` ->
 * `reviewA11y`), so if a code change moves the certified numbers, this fails.
 *
 * It also guards the artifacts against silent staleness: `deriveKey()` is the
 * single source of truth for the item->case map, so if CASES drifts the committed
 * key no longer matches and this test catches it before the cert can rot.
 */

const CERT_DIR = fileURLToPath(new URL("../experiments/corpus-recall/certification", import.meta.url));

type PassNoms = Record<string, Omit<ReviewCandidate, "file">[]>;

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(`${CERT_DIR}/${name}`, "utf8")) as T;
}

const committedKey = readJson<Record<string, string>>("key.json");
const passes: PassNoms[] = [
  readJson<PassNoms>("noms-pass-1.json"),
  readJson<PassNoms>("noms-pass-2.json"),
  readJson<PassNoms>("noms-pass-3.json"),
];

describe("recall certification — the committed certificate is an enforced gate", () => {
  it("committed key matches the key derived from current CASES", () => {
    // If CASES is reordered / added to / pruned, deriveKey() moves and the
    // committed key.json goes stale — re-run blind-harness build and re-bless.
    expect(deriveKey()).toEqual(committedKey);
  });

  it("exactly 3 blind passes are committed", () => {
    expect(passes).toHaveLength(3);
    for (const p of passes) expect(typeof p).toBe("object");
  });

  it("the hook's certified-pattern allowlist equals the certified positive set", () => {
    // CERTIFIED_RECALL_PATTERN_IDS (what the edit-time hook may advise on) must be
    // exactly the patterns the positive fixtures here actually certify — no more
    // (advising on an unmeasured pattern), no less (a certified pattern the hook
    // hides). Adding a positive for a new pattern forces updating the allowlist.
    const certified = new Set<string>();
    for (const c of CASES) {
      if (c.kind === "positive") for (const e of c.expect) certified.add(e.patternId);
    }
    expect([...certified].sort()).toEqual([...CERTIFIED_RECALL_PATTERN_IDS].sort());
  });

  it("every certified id maps to a corpus pattern at a flaggable tier", () => {
    // A tier demotion (very-common/common → occasional) would silently flip the
    // pattern's `eligibleToFlag` false and drop it from the hook while the id stays
    // certified — a quiet recall loss. Guard the certified set against that drift.
    const byId = new Map(corpusPatterns().map((p) => [p.id, p]));
    const flaggable = new Set(["very-common", "common"]);
    for (const id of CERTIFIED_RECALL_PATTERN_IDS) {
      const pattern = byId.get(id);
      expect(pattern, `certified id ${id} has no corpus pattern`).toBeDefined();
      expect(flaggable.has(pattern?.tier ?? "unknown"), `${id} tier=${pattern?.tier}`).toBe(true);
    }
  });

  it("re-scores the committed nominations to a passing certificate", { timeout: 30_000 }, async () => {
    const r = await scoreArtifacts(committedKey, passes);

    // No nomination dropped: every item-id maps to a live case (artifacts current).
    expect(r.totalDropped).toEqual([]);
    // Zero decoy leaks: nothing surfaced on any negative across all 3 passes.
    expect(r.totalDecoyLeaks).toBe(0);
    // Point precision 1.0 — every surfaced finding correct.
    expect(r.pooledCorrect).toBe(r.pooledTotal);
    // Enough pooled evidence for the Wilson bound to bite.
    expect(r.pooledTotal).toBeGreaterThanOrEqual(70);
    // THE GATE: pooled Wilson 95% lower bound clears 0.95.
    expect(r.pooledWilson).toBeGreaterThanOrEqual(0.95);
    expect(r.pass).toBe(true);
  });
});
