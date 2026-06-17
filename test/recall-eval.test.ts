import { describe, expect, it } from "vitest";
import { CASES, type LabelledCase } from "../experiments/corpus-recall/case-set";
import {
  type Nominations,
  PRECISION_FLOOR,
  runEval,
  wilsonLowerBound,
} from "../experiments/corpus-recall/eval";
import type { ReviewCandidate } from "../src/review";

// The harness is scored with SYNTHETIC nominations (no model): the runner is the
// deterministic shell, so feeding it engineered candidates pins down precision,
// recall, and the G0-G6 veto behavior mechanically — the same path the real
// grounded run will drive, minus the model.

const byId = new Map(CASES.map((c) => [c.id, c]));

function caseFor(id: string): LabelledCase {
  const c = byId.get(id);
  if (c === undefined) throw new Error(`no such fixture: ${id}`);
  return c;
}

/** A nomination on a POSITIVE fixture's expected anchor (the correct catch). */
function correctNomination(id: string, codeQuote: string): ReviewCandidate {
  const c = caseFor(id);
  if (c.kind !== "positive") throw new Error(`${id} is not a positive`);
  const e = c.expect[0]!;
  return {
    file: c.file,
    line: e.line,
    patternId: e.patternId,
    codeQuote,
    wcag: e.wcag,
    confidence: "high",
    message: "Recall: a failure the static floor missed.",
    justification: "The floor stays silent here; the quote is a real, un-suppressed element.",
  };
}

/** A nomination on a NEGATIVE fixture's suppressed line (a decoy the gate must veto). */
function decoyNomination(id: string, over: Partial<ReviewCandidate>): ReviewCandidate {
  const c = caseFor(id);
  return {
    file: c.file,
    line: 0,
    patternId: "4.1.2-button-no-name",
    codeQuote: "",
    wcag: ["4.1.2"],
    confidence: "high",
    message: "Decoy.",
    justification: "Engineered to die at a specific gate.",
    ...over,
  };
}

describe("recall:eval — the Wilson lower bound", () => {
  it("is honest about a tiny sample: 6/6 is well under 1.0", () => {
    // 6 correct of 6 surfaced is a point-precision of 1.0 but NOT enough evidence
    // to certify 0.95 — the whole reason the gate uses the bound, not the point.
    const lb = wilsonLowerBound(6, 6);
    expect(lb).toBeGreaterThan(0.5);
    expect(lb).toBeLessThan(PRECISION_FLOOR);
  });

  it("matches the closed-form Wilson value on a known count (47/50)", () => {
    // Closed-form with z=1.959964: p̂=0.94, lower ≈ 0.8378291 (verified against an
    // independent computation). Pins the formula so a refactor that silently
    // changes z or the algebra is caught.
    expect(wilsonLowerBound(47, 50)).toBeCloseTo(0.8378291, 5);
  });

  it("returns 1 for the empty sample (nothing surfaced ⇒ no precision leak)", () => {
    expect(wilsonLowerBound(0, 0)).toBe(1);
  });

  it("tightens toward the point estimate as the sample grows", () => {
    // Same 100% point precision, more evidence ⇒ a higher (tighter) lower bound.
    expect(wilsonLowerBound(60, 60)).toBeGreaterThan(wilsonLowerBound(6, 6));
  });

  it("clamps a degenerate lower bound to 0, never negative", () => {
    expect(wilsonLowerBound(0, 1)).toBe(0);
  });
});

describe("recall:eval — scoring synthetic nominations through the real gate stack", () => {
  it("empty nominations: nothing surfaces, precision vacuously 1.0, recall 0", async () => {
    const r = await runEval({});
    expect(r.surfacedTotal).toBe(0);
    expect(r.precision).toBe(1);
    expect(r.precisionWilsonLower).toBe(1);
    expect(r.caughtTotal).toBe(0);
    expect(r.recall).toBe(0);
    expect(r.pass).toBe(true); // no precision leak to bound
  });

  it("a correct positive nomination counts as recall AND as a correct surface", async () => {
    const noms: Nominations = {
      "positive/generic-link-text": [correctNomination("positive/generic-link-text", "<Link")],
    };
    const r = await runEval(noms);
    expect(r.caughtTotal).toBe(1);
    expect(r.surfacedTotal).toBe(1);
    expect(r.surfacedCorrect).toBe(1);
    const c = r.cases.find((x) => x.id === "positive/generic-link-text");
    expect(c?.caught).toBe(1);
    expect(c?.surfaced[0]?.correct).toBe(true);
  });

  it("all six positives surface their expected finding (recall = 1.0)", async () => {
    const noms: Nominations = {
      "positive/generic-link-text": [correctNomination("positive/generic-link-text", "<Link")],
      "positive/learn-more-link": [correctNomination("positive/learn-more-link", "<Link")],
      "positive/noisy-link-name": [correctNomination("positive/noisy-link-name", "<Link")],
      "positive/raw-anchor-noisy-name": [correctNomination("positive/raw-anchor-noisy-name", "<Link")],
      "positive/tab-selected-state-missing": [
        correctNomination("positive/tab-selected-state-missing", "<Tab"),
      ],
      "positive/tab-current-item-missing": [
        correctNomination("positive/tab-current-item-missing", "<Tab"),
      ],
    };
    const r = await runEval(noms);
    expect(r.recall).toBe(1);
    expect(r.caughtTotal).toBe(6);
    // Every surfaced finding is correct ⇒ point precision 1.0; no FP leaks.
    expect(r.precision).toBe(1);
    expect(r.surfacedCorrect).toBe(r.surfacedTotal);
  });

  it("G3: a decoy on a Tooltip-suppressed line is VETOED — precision stays 1.0", async () => {
    // The decoy targets the inner IconButton (line 12) under a titled <Tooltip>.
    // G3 (name-injecting-wrapper) drops it, so it NEVER reaches `surfaced` and is
    // NOT counted as a false positive the gate let through — the suppressor wall
    // is what keeps precision intact, exactly as the floor's FP discipline intends.
    const decoy = decoyNomination("negative/tooltip-titled-icon-button", {
      line: 12,
      codeQuote: "<IconButton>",
    });
    const r = await runEval({ "negative/tooltip-titled-icon-button": [decoy] });
    const c = r.cases.find((x) => x.id === "negative/tooltip-titled-icon-button");
    expect(c?.surfaced).toEqual([]);
    expect(r.surfacedTotal).toBe(0);
    expect(r.precision).toBe(1);
  });

  it("G3: a decoy on a FormLabel-wrapped Select line is VETOED (label-ancestor)", async () => {
    const decoy = decoyNomination("negative/form-label-wrapped-select", {
      line: 12,
      patternId: "4.1.2-form-control-no-name",
      codeQuote: "<Select",
      wcag: ["4.1.2"],
    });
    const r = await runEval({ "negative/form-label-wrapped-select": [decoy] });
    const c = r.cases.find((x) => x.id === "negative/form-label-wrapped-select");
    expect(c?.surfaced).toEqual([]);
  });

  it("G3 (resolved-host): a decoy on a resolved Radix toggle is VETOED (toggle-role)", async () => {
    // The call site `<CheckboxRoot />` looks nameless, but the source-tracer
    // follows its import to the def file on disk and resolves it to
    // `button[role=checkbox]` — a toggle. S1's resolved-host suppressor G3
    // (`toggle-role`) drops the nomination. This is the FP class the first eval
    // was blind to (no resolved-host decoy existed).
    const decoy = decoyNomination("negative/radix-toggle-checkbox", {
      line: 11,
      codeQuote: "<CheckboxRoot",
    });
    const r = await runEval({ "negative/radix-toggle-checkbox": [decoy] });
    const scored = r.cases.find((x) => x.id === "negative/radix-toggle-checkbox");
    expect(scored?.surfaced).toEqual([]);
    expect(r.surfacedTotal).toBe(0);
    expect(r.precision).toBe(1);
  });

  it("G3 (resolved-host): a decoy on a rendersOwnName control is VETOED (renders-own-name)", async () => {
    // `<PrevSlideButton />` renders its own `sr-only` name inside the wrapper. The
    // tracer reads the def off disk, captures `rendersOwnName`, and G3
    // (`renders-own-name`) vetoes the decoy.
    const decoy = decoyNomination("negative/sr-only-named-control", {
      line: 11,
      codeQuote: "<PrevSlideButton",
    });
    const r = await runEval({ "negative/sr-only-named-control": [decoy] });
    const scored = r.cases.find((x) => x.id === "negative/sr-only-named-control");
    expect(scored?.surfaced).toEqual([]);
    expect(r.surfacedTotal).toBe(0);
    expect(r.precision).toBe(1);
  });

  it("G1: a non-vocabulary patternId is DROPPED before it can surface", async () => {
    // `color-contrast-…` is real WCAG but never a distilled slice pattern, so G1
    // (closed vocabulary) drops it — it cannot become a finding regardless of the
    // line or quote. Asserted on a positive fixture (real JSX, un-suppressed) so
    // ONLY G1 can be the cause of the drop.
    const c = caseFor("positive/generic-link-text");
    const offVocab: ReviewCandidate = {
      file: c.file,
      line: 9,
      patternId: "color-contrast-not-in-corpus",
      codeQuote: "<Link",
      wcag: ["1.4.3"],
      confidence: "high",
      message: "Off-vocabulary.",
      justification: "Not a slice pattern — G1 must drop it.",
    };
    const r = await runEval({ "positive/generic-link-text": [offVocab] });
    expect(r.surfacedTotal).toBe(0);
  });

  it("a real false positive (a survivor on a clean negative) DOES lower precision", async () => {
    // The control: feed a nomination that actually CLEARS the gate stack but lands
    // on a clean negative (named-link — no suppressor, no abstention, real JSX). It
    // surfaces, is NOT expected, so it is counted as the precision leak it is. This
    // proves the harness is not vacuously perfect — it can fail.
    const c = caseFor("negative/named-link");
    const leak: ReviewCandidate = {
      file: c.file,
      line: 8,
      patternId: "2.4.4-generic-link-text",
      codeQuote: "<Link",
      wcag: ["2.4.4"],
      confidence: "high",
      message: "False positive on a correctly-named link.",
      justification: "A misclassification the gates cannot catch — only the model's G7 can.",
    };
    const r = await runEval({ "negative/named-link": [leak] });
    expect(r.surfacedTotal).toBe(1);
    expect(r.surfacedCorrect).toBe(0);
    expect(r.precision).toBe(0);
    expect(r.precisionWilsonLower).toBeLessThan(PRECISION_FLOOR);
    expect(r.pass).toBe(false);
  });
});

describe("recall:eval — the case set", () => {
  it("has ~6 positive and ~6 hard-negative fixtures", () => {
    const positives = CASES.filter((c) => c.kind === "positive");
    const negatives = CASES.filter((c) => c.kind === "negative");
    expect(positives.length).toBeGreaterThanOrEqual(6);
    expect(negatives.length).toBeGreaterThanOrEqual(6);
  });

  it("every positive expects at least one (patternId, line, wcag) finding", () => {
    for (const c of CASES) {
      if (c.kind !== "positive") continue;
      expect(c.expect.length).toBeGreaterThan(0);
      for (const e of c.expect) {
        expect(e.patternId).toMatch(/^\d+\.\d+\.\d+-/);
        expect(e.line).toBeGreaterThan(0);
        expect(e.wcag.length).toBeGreaterThan(0);
      }
    }
  });
});
