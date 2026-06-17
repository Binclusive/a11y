# corpus-recall — the recall-layer eval (`pnpm recall:eval`)

The measurement machinery for the corpus → agent recall layer (RFC Phase 1, §1f).
It scores a set of per-fixture **nominations** through the **real** `reviewA11y`
verify gate stack (G0–G8) and reports **precision (Wilson lower bound)** + recall
over a labelled fixture set.

This harness is **separate from `matrix:check` by construction**: `matrix:check`
is a count-snapshot gate for the static *floor*; `recall:eval` is a precision-
floor gate for the recall *ceiling*. They never share a baseline.

## First grounded run (2026-06-17)

3 independent **blind** grounding passes (model nominations produced without
sight of the labels), scored through the real gate stack:

| Metric | Value |
|---|---|
| Precision (point) | **1.000** — 18/18 surfaced findings correct |
| Recall | **1.000** — 18/18 positives caught |
| False positives on the 6 hard decoys | **0** (Tooltip / FormLabel / aria-label / floor-caught all stayed silent) |
| Precision **Wilson 95% lower bound** | **0.824** → below the 0.95 gate |

Read: the layer is **perfect on this set** — zero decoy leakage, full recall.
The Wilson gate is **FAIL only on sample size**: 18 all-correct samples can
statistically certify ≥0.82, not ≥0.95. The bound is conservative on purpose.
**Clearing the gate is a corpus-growth task** (≈60 all-correct surfaced findings,
i.e. ~20 positive fixtures × 3 passes), not a code change. The gate is nightly +
non-blocking, so it trends toward green as the fixture set grows.

## What it is and is not

- It **is** the deterministic scoring + the Wilson gate, driven through the exact
  shipped path (`reviewA11y({ verify, candidates })`). It certifies the deployed
  channel, not a proxy.
- It is **not** the grounded run. The runner **never calls a model**. Grounding
  is a **pluggable input**: a `Nominations` map (`{ fixtureId -> ReviewCandidate[] }`).
  The unit tests feed it synthetic candidates; the **real grounded run is manual**
  (later) and feeds it real model nominations.

## Layout

```
case-set.ts            the labelled fixtures (id, file, kind, expect|clean)
cases/positive/*.tsx   code that exhibits a corpus pattern the static FLOOR MISSES
cases/negative/*.tsx   hard decoys (same components) that must surface ZERO
eval.ts                runEval(nominations) -> EvalReport; wilsonLowerBound; CLI
```

### The fixtures

- **POSITIVE** (6) — a non-floor failure the floor cannot see: non-descriptive /
  noisy link text (`2.4.4-generic-link-text`, `2.4.4-noisy-or-wrong-name`),
  missing selected/current state on a custom tab
  (`4.1.2-selected-or-current-state-missing`). Each carries the
  `expect: [{ patternId, line, wcag }]` the recall layer should surface.
- **NEGATIVE** (6, the precision spine) — the SAME components in a clean
  configuration: a Tooltip-titled IconButton (G3 name-injecting-wrapper), a
  FormLabel-wrapped Select (G3 label-ancestor), a floor-already-caught empty
  anchor (cross-dedup), and correctly-named controls the agent must abstain on.
  Each carries `clean: true` and must surface nothing.

## The gate

`precision Wilson-lower-bound >= 0.95` (RFC resolved decision, **locked**). Recall
is **reported and soft-floored only** — a low recall never fails the gate.

**Why Wilson, not the point estimate:** a small sample lies. 6 correct of 6 is a
point-precision of 1.0 but a Wilson lower bound of ~0.61 — *not* enough evidence
to certify 0.95. The bound tightens toward the point estimate as the sample
grows, which is why the real run takes **K=5 samples per case**: it accumulates
enough surfaced findings for the bound to clear the floor when precision really is
high. A lucky-but-tiny run cannot pass.

## The manual grounded run (later)

1. Call `reviewA11y({ files: [fixture] })` (retrieve) for each case to get the
   `corpusContext` + `suppressorMap` the agent grounds on.
2. Have the model nominate candidates for each fixture (K=5 independent samples).
3. Assemble the `Nominations` map (`fixtureId -> ReviewCandidate[]`) and call
   `runEval(map)`.
4. Read `report.pass` (the Wilson gate) and `report.recall` (tracked, not gated).

`pnpm recall:eval` with no map wired in prints the **empty-nomination baseline**
(nothing surfaces, precision vacuously 1.0, recall 0) — it proves the wiring is
green end-to-end until the manual run supplies real nominations.
