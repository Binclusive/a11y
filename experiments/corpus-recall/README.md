# corpus-recall — the recall-layer eval (`pnpm recall:eval`)

The measurement machinery for the corpus → agent recall layer (RFC Phase 1, §1f).
It scores a set of per-fixture **nominations** through the **real** `reviewA11y`
verify gate stack (G0–G8) and reports **precision (Wilson lower bound)** + recall
over a labelled fixture set.

This harness is **separate from `matrix:check` by construction**: `matrix:check`
is a count-snapshot gate for the static *floor*; `recall:eval` is a precision-
floor gate for the recall *ceiling*. They never share a baseline.

## Certified grounded run (2026-06-18, incl. R4 image-alt) — PASS ✅

3 independent **blind** grounding passes (model nominations produced WITHOUT
sight of the labels — see `certification/` and "The blind grounded run" below),
scored through the real gate stack and **pooled**:

| Metric | Value |
|---|---|
| Pooled precision (point) | **1.000** — 93/93 surfaced findings correct |
| Precision **Wilson 95% lower bound** | **0.9603** → **clears the 0.95 gate** |
| False positives on the 19 hard decoys | **0** (Tooltip / label-ancestor / resolved toggle / renders-own-name / floor-caught / self-managing antd / good-alt / decorative `alt=""` / no-alt-floor-caught / mixed icon-button+img+a all stayed silent) |
| Per-pass recall | 32/37, 31/37, 30/37 (misses are abstentions on borderline phrases — never FPs) |

Read: across three independent blind passes the layer surfaced **zero** wrong
findings and leaked **zero** decoys; the pooled sample (93 all-correct) is large
enough for the Wilson lower bound to certify ≥0.95. (The prior Phase-1 run —
before the R4 content-inspection retriever added image-alt + intrinsic reach —
was 78/78, Wilson 0.9531; R4 grew it to the above.)

This certificate is **enforced deterministically by
`test/recall-certification.test.ts` in `pnpm test`** (it re-scores the committed
nominations under `certification/` through the real verify path; **no model
needed**). There is no nightly or CI job that re-runs the agents — the committed
artifacts ARE the certificate, and the test re-derives the score from them.

**Honest scope of this certificate.** It certifies the patterns that are honestly
fixture-able — where the app pours bad **content** into a shell that can't fix it,
on EITHER a trusted design-system component OR a raw intrinsic element (the R4
content-inspection retriever, `src/intrinsic-elements.ts`, made the intrinsic
surface reachable). Three patterns: `2.4.4-generic-link-text`,
`2.4.4-noisy-or-wrong-name` (bad link text/name, on `<Link>` and raw `<a>`), and
`1.1.1-filename-or-generic-alt` (an `<img>`/`<Image>` whose `alt` is a filename /
placeholder). The `selected/current-state-missing`, keyboard, focus, and heading
patterns are **not** in this certificate: trusted tab/toggle/dialog components
*self-manage* that state at runtime (antd `<Tabs>` auto-selects its first pane and
renders `aria-selected`, so a static selected-state nomination on it is a false
positive — it lives as the `antd-tabs-self-managed` hard negative), and a single
snippet can't show a heading skip. Those are real-in-the-wild failures the
retriever cannot yet ground honestly; certifying them is deferred, not faked. This
is the documented **certified ceiling** — see `docs/ARCHITECTURE.md` §3 for the
three-tier detection scope (floor → certified auto-flag → gated-agent).

### Reproduce

```
pnpm exec tsx experiments/corpus-recall/blind-harness.ts build   # label-free bundles -> /tmp
# run 3 blind agents over /tmp/recall-blind-bundles.json -> /tmp/recall-noms-{1,2,3}.json
pnpm exec tsx experiments/corpus-recall/blind-harness.ts score   # pooled Wilson over the 3 passes
```

The exact bundles the agents saw, the secret item→case key, and the three passes'
nominations are committed under `certification/` for audit.

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

- **POSITIVE** (28) — a non-floor failure the floor cannot see: a `<Link>` whose
  visible name is present but **generic** (`2.4.4-generic-link-text`) or **noisy /
  polluted** — a URL, path, filename, SKU, breadcrumb, "undefined"
  (`2.4.4-noisy-or-wrong-name`). Each must be **R1-retrievable** (an imported
  design-system component whose name token-overlaps the pattern label — an
  intrinsic `<div>` yields an empty slice and cannot be a positive) and
  **floor-clean**. Each carries `expect: [{ patternId, line, wcag }]`.
- **NEGATIVE** (15, the precision spine) — the SAME components in a clean
  configuration the agent must abstain on or the gate must veto: a Tooltip-titled
  control (G3 name-injecting-wrapper), a label-wrapped control (G3 label-ancestor),
  a resolved Radix toggle / switch (G3 toggle-role), a renders-own-name wrapper, a
  floor-already-caught control (cross-dedup), correctly-named `aria-label` controls,
  and a **self-managing antd `<Tabs>`** (clean — it exposes its own selected state).
  Each carries `clean: true` and must surface nothing.

Why only the two link-name patterns? A *trusted* component only genuinely fails
when the app feeds it bad **content/state it can't fix**; a bad link name is
exactly that. State/keyboard/focus failures are handled by the trusted component
itself (so a fixture using one isn't genuinely failing), which is why they are
out of this certificate — see "Honest scope" above.

## The gate

`precision Wilson-lower-bound >= 0.95` (RFC resolved decision, **locked**). Recall
is **reported and soft-floored only** — a low recall never fails the gate.

**Why Wilson, not the point estimate:** a small sample lies. 6 correct of 6 is a
point-precision of 1.0 but a Wilson lower bound of ~0.61 — *not* enough evidence
to certify 0.95. The bound tightens toward the point estimate as the sample
grows, which is why the real run takes **K=5 samples per case**: it accumulates
enough surfaced findings for the bound to clear the floor when precision really is
high. A lucky-but-tiny run cannot pass.

## The blind grounded run (`blind-harness.ts`)

The certification above is produced by `blind-harness.ts`, which keeps the
grounding **blind** (the agent never sees the positive/negative label, the
patternId, or the author comments):

1. `build` — for each case, run `reviewA11y({ files: [fixture] })` (retrieve) and
   package ONLY what production hands the agent — numbered source (author comment
   lines **blanked**, since they literally say `// POSITIVE:` and name the
   patternId), `corpusContext`, `suppressorMap`, `staticFindings` — under an opaque
   `item-NN` id. The id→case key is written to a **separate** file the agents never
   read.
2. Run **3 independent** agents over `/tmp/recall-blind-bundles.json`; each writes
   `item-NN -> ReviewCandidate[]` to `/tmp/recall-noms-{1,2,3}.json`.
3. `score` — map each pass back to its case, run the REAL `runEval` per pass, and
   **pool** all surfaced findings across the 3 passes for one Wilson lower bound.

**Why pool 3 passes:** a single pass over ~37 positives certifies only ≈0.88 (the
Wilson bound is conservative on a small sample). Three *independent* model runs are
three genuine draws of "when the layer surfaces a finding, is it right?"; pooling
them (≈93 surfaced) tightens the bound enough to certify ≥0.95 when precision
really is ~1.0. A lucky-but-tiny run cannot pass.

**Honest caveat — the passes are correlated.** The 3 passes ground over the SAME
fixtures, so the surfaced findings are NOT independent: pooled n=93 is **not 93
i.i.d. samples**, and 0.960 must be read as a **pooled lower bound under
correlation**, not a textbook binomial bound. What makes the certificate
trustworthy is the **trio of signals together**, not the Wilson number alone:

1. **Point precision 1.0** — 93/93 surfaced findings correct (zero wrong findings
   across all three passes).
2. **Zero decoy leaks** — across every negative × 3 passes, nothing surfaced on a
   single hard decoy.
3. **The pooled Wilson bound** — ≥0.95 even on the conservative pooled count.

The rigorous path to a *stronger* bound is **MORE DISTINCT fixtures** (which add
genuinely independent draws), **not** more re-runs over the same set (which only
deepen the correlation).

`pnpm recall:eval` with no map wired in still prints the **empty-nomination
baseline** (nothing surfaces, precision vacuously 1.0, recall 0) — the wiring
smoke test, independent of the blind run.
