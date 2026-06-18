# RFC: Corpus Regeneration Flywheel (the compounding layer)

Status: **Design — v3, revised after a second review** · Date: 2026-06-18
Successor to `docs/rfc-phase1-detection.md` (the recall layer reads the corpus;
this makes the corpus *grow itself*). Tracks epic Binclusive/monorepo#1645,
blocked on the migration epic #1646. Revised twice: a first 3-agent review folded
B1–B3 (see **Review log**); a second grill + 3 skeptical verifiers (2026-06-18)
folded the **detection-layer coupling**, the **containment metric**, the **aging
story**, **incremental clustering**, and surfaced the `avt_*` id contract as a
blocking unknown — and corrected two over-reaches the grill made (see end).

> Close the loop: cloud audits → new findings → re-cluster → corpus grows →
> sharper checker + better-grounded agents. The whole design turns on one
> property: **monotonicity** — a regeneration can add or improve a pattern,
> never delete or downgrade a blessed one without a human.

**Scope (held across both reviews):** build the **deterministic spine (F0–F2) as a
human-triggered cadence now**; **defer the unattended verifier + nightly loop
(F3–F4)** until (a) Phase 1 *detection* is live and (b) measured new-org cadence
shows a human reviewing the cluster-diff is the bottleneck. The second review
challenged this cut ("build detection breadth first") and **withdrew the
challenge**: detection already retrieves ~100 patterns over the 51 shipped, so it
is not a thin consumer; and F1's monotonic invariant is a *safety rail* best built
while the corpus is small and hand-reviewable, before growth is load-bearing.
Building the spine is *not* "growing the corpus ahead of the constraint" — the
machinery sits idle until run, and running is gated behind detection.

---

## The decision

A regeneration pipeline that re-clusters the corpus from the growing raw-audit
export, with a gate that lets good clusters through and benches the rest:

```
new audit findings (cloud)
  │
  ▼
① RE-CLUSTER          re-cluster the corpus from the raw-finding export → cluster files + prose
  ▼
② DETERMINISTIC GATE  containment-match · k≥3 floor · drop-ledger Δ · matrix:check · corpus-baseline Δ · RECALL-CERT
  ▼
③ VERIFY  [F3, deferred]  unanimous skeptics refute the failureShape AND the fix/SC mapping
  ▼
④ DECIDE              all green → ship cluster · any red → quarantine + retain last-good
```

Human-triggered today (cadence); ③ + an auto nightly trigger are the deferred
autonomy. The deterministic gate (②) owns the pass/fail decision; the model (③)
only ever enters last, behind the mechanical checks — the same "model trust is
genuinely last" discipline as the Phase 1 verify stack. **②'s recall-cert check
(new, below) is the deterministic gate that keeps a regeneration from silently
breaking the certified detection layer** — the second review's sharpest finding
was that this check existed in `pnpm test` but was absent from the gate.

## The monotonic invariant (the keystone)

> A regeneration can **add** a pattern or **replace** one with a verified-better
> version. It can **never** delete or downgrade a previously-blessed pattern
> without a human. The shipped corpus is always
> `(verified-new clusters) ∪ (last-good versions of the rest)`.

"Quarantine" means **reject the new candidate, keep the last-blessed version** —
never *drop*. Dropping loses the real findings a cluster represents (silent
coverage regression). Worst case becomes a *stale* pattern, never *missing*.

**Caveat the v3 makes explicit (was overclaimed as "never wrong"):** "stale" is
safe for the customer **report** (display prose) but is **not** safe for two live
decisions — the **frequency tier** that drives `eligibleToFlag` (see *Detection
coupling*) and a pattern the world has **fixed** (see *Pattern aging*). A stale
pattern that still gates detection, or still asserts a failure the ecosystem
corrected, *is* wrong. The invariant freezes those; the v3 adds the live-tier fix
and the retirement signal so "monotonic" doesn't quietly mean "accretes wrong
forever."

## Cluster identity — containment, not symmetric Jaccard (the metric fix)

The invariant is only true if "the rest" is well-defined: each new cluster must
be matched to its prior last-good twin. **The match key is finding-set membership,
NOT the slug.** Pattern slugs (`4.1.2-button-no-name`) are LLM-authored free text —
nothing canonicalizes them — so keying identity on the slug degrades the invariant
to "never delete a pattern *whose slug the model happens to reproduce.*"

**Match by asymmetric CONTAINMENT of the blessed set, not symmetric Jaccard.**
The first review proposed Jaccard overlap (`|A∩B|/|A∪B|`) of the `avt_*` id sets.
But the flywheel's whole purpose is to make those sets **grow**, and symmetric
Jaccard *fights its own growth*: a blessed 5-finding cluster that grows to 50 (the
goal) scores `5/50 = 0.10` — reading as a non-match. Use **containment of the
fixed blessed reference**:

```
containment = |old ∩ new| / |old|     # fraction of the BLESSED findings the candidate still holds
```

- **Growth-invariant by construction:** the 5→50 case scores `5/5 = 1.0`. The old
  set is the fixed denominator, so accretion never lowers the score.
- **Threshold:** `containment ≥ 0.7` → confident match, carry the blessed lineage
  forward. Below threshold on every old twin → net-new (clears the full gate). A
  blessed set whose containment **splits across ≥2 new candidates** (each below
  threshold, union ≥ threshold) → a split → **both sides quarantine-retain**.
  Symmetric Jaccard had no single threshold that separated "same pattern, grown"
  (which demanded accepting ~0.10) from "different pattern, incidental overlap"
  (~0.25) — the orderings crossed; containment removes the crossing.
- **Split (1→many) / merge (many→1) still route to quarantine-retain.** Without
  this, a blessed cluster whose findings re-partition — one half dropping below
  k=3 — would *vanish through green gates* (counts don't move; `matrix:check` is
  unaffected). Containment makes the detection sharper: a true split drops the
  blessed set's containment below threshold across *every* child.
- **Threshold is a stated parameter, with a safe default:** on any ambiguity
  (no confident match, or a near-tie between two old twins) the matcher errs to
  **quarantine-retain**, whose worst case the invariant already tolerates. F1 must
  unit-test the boundary directly, including the split/merge and near-tie cases.

> **Blocking unknown — `avt_*` id stability.** The whole matcher rests on the
> `avt_*` ids being **stable per logical defect** (a re-audit of the same site
> yields the same ids). This repo establishes only that they are *opaque*; their
> generation lifecycle lives upstream (`b8e` / monorepo). **If `avt_*` is
> per-occurrence** (a fresh id each scan), a re-audit mints a near-disjoint
> finding-set → the matcher reads stable real-world facts as all-new → mass
> false-quarantine, and the keystone is void. **Cite the upstream id contract and
> confirm per-defect stability before building F1.** If it is per-occurrence, F1
> needs a defect-canonicalization step *before* the matcher.

## Why re-cluster churn is safe (for the engine) — and where it ISN'T (detection)

- `experiments/stack-matrix/baseline.json` carries **no** pattern-id references.
- `src/corpus.ts` enrichment matches findings **by WCAG SC**, not by pattern id,
  and dedups by id — so re-clustering changes only display text *for the engine's
  enrichment*.
- **But the recall/detection layer is NOT SC-keyed and is NOT churn-safe.** It
  binds to hand-authored **slugs** (`CERTIFIED_RECALL_PATTERN_IDS` in
  `src/retrieve.ts`) and to the per-pattern **frequency tier**. Churn there can
  silently invalidate certified detection — which is why the recall cert is now a
  gate and `eligibleToFlag` must read a live tier (next section).

Note: the earlier draft claimed slugs "re-derive deterministically." They don't —
they are hand-authored in the cluster files. Engine churn-safety rests on
**SC-keyed enrichment**; cluster identity rests on the **containment matcher**;
detection churn-safety rests on the **two coupling fixes below**.

## Detection-layer coupling (the cross-layer gate — second review's core finding)

The flywheel mutates exactly what the certified recall layer consumes: which
pattern slugs exist, their tiers, their failureShapes. Two couplings the gate must
honor, or a regeneration passes every other check while breaking detection:

1. **Re-run `test/recall-certification.test.ts` as gate ②.** It deterministically
   asserts: every `CERTIFIED_RECALL_PATTERN_IDS` slug still resolves to a corpus
   pattern, that pattern sits at a flaggable tier, and pooled precision clears the
   Wilson 0.95 floor with zero decoy leaks. A regeneration that renames a certified
   slug or demotes its tier turns this **red** — *but only if the gate runs it*.
   `matrix:check` cannot stand in: it captures only axe `byRule` counts
   (`experiments/stack-matrix/baseline.ts`), so failureShape/fix/tier churn leaves
   it **byte-identical** — it catches an SC-*coverage* regression on real code and
   nothing else the flywheel produces. Necessary, but narrow; the recall cert is
   the check that actually guards measured detection precision.

2. **`eligibleToFlag` must read a LIVE tier, not frozen JSON.** Today
   `eligibleToFlag = FLAGGABLE_TIERS.has(p.tier)` (`src/retrieve.ts`) where the
   per-pattern `p.tier` is the **frozen** `frequencyTier` baked into
   `data/corpus/patterns-*.json`, while the SC-level tier is recomputed live via
   `tierForOrgs` (`src/corpus.ts`). Under monotonic-retain a blessed cluster keeps
   its **old** tier when current data drops below k. So a pattern blessed
   `very-common` at 16 orgs, now hit by 1, keeps `eligibleToFlag: true` and keeps
   flagging at full authority. The recall cert catches a *demotion that crosses
   below flaggable*; it does **not** catch a pattern that stays frozen-high while
   reality drops. Fix: recompute flag-eligibility from the **current** org count at
   retrieve time (carry a live tier on the retrieved pattern), so the detection
   decision never rides a frozen frequency.

## Pattern aging — retirement + re-verification (the time dimension the RFC missed)

The invariant governs how patterns **enter** and are **retained**; both reviews
confirmed it is silent on how they **age**. Two additions, both human-gated (so
still monotonic-with-human):

- **Absence-driven retirement.** A pattern the world has fixed (a framework ships
  a correct default) generates **no new findings** → matches no candidate → is
  retained as last-good **forever** → the checker flags a non-problem and the
  report ships a fix for it. Nothing in the current design can even *notice* this.
  Add an absence signal: a blessed pattern whose `avt_*` ids fail to reappear
  across **M consecutive regenerations over a growing corpus** is evidence the
  world moved → route it to a **human retirement queue** (symmetric to quarantine,
  opposite polarity). Retirement still needs a human — the invariant holds — but
  now there is a mechanism that surfaces the candidate.

- **Re-verification of the retained substrate.** Monotonic-retain never re-runs a
  gate on a retained pattern, so patterns blessed **before F3** (by the weaker
  pre-verifier process) are the most permanent and **never skeptic-checked** —
  quality is inversely correlated with permanence. When F3 lands, run a **one-time
  backfill sweep** of the entire retained corpus through the verifier (re-bless or
  quarantine), keyed on the `verifyStatus` provenance F1 records; thereafter
  re-verify a retained pattern whenever a regeneration touches its SC.

## The gate — mostly already built

| # | Check | Kind | Status |
|---|---|---|---|
| ② identity | **Containment** match on `avt_*` sets; split/merge → quarantine | deterministic | **new (v3: containment, not Jaccard)** |
| ② k≥3 | `MIN_ORGS=3` distinct-org floor (`src/distill/distill.ts`) | deterministic | **exists** |
| ② drop-ledger Δ | `belowK` / `unclassified` counts vs last run (`ledger-*.json`) | deterministic | **exists** |
| ② matrix Δ | `matrix:check` over 31 pinned repos — SC-coverage regression only; byte-blind to corpus content | deterministic | **exists (narrow)** |
| ② corpus-baseline Δ | per-SC pattern count, distinct findings in the shipped union, ledger totals | deterministic | **new** |
| ② **recall-cert** | re-run `recall-certification.test.ts`: certified-slug↔corpus binding, flaggable tier, Wilson ≥0.95 | deterministic | **new (v3)** |
| ③ verify | unanimous skeptics refute shape + fix/SC mapping | model | **new, deferred (F3)** |

## Failure modes → guards

| Failure mode | Caught by |
|---|---|
| A blessed cluster vanishes via split below k | **② containment matcher** (split → quarantine-retain) — *not* the drop-ledger, which can't tell a lost cluster from a new sub-k one |
| A grown cluster spuriously benched as "different" | **② containment** (growth-invariant; symmetric Jaccard could not) |
| A regen renames a certified slug / demotes a certified tier | **② recall-cert** (binding + tier assertion go red) — `matrix:check` is blind to it |
| A retained pattern flags on a frozen-stale tier | **live-tier `eligibleToFlag`** (recompute from current org count) |
| A pattern the world fixed flags forever | **absence-driven retirement signal** → human queue |
| A pre-F3 weak pattern is permanent + unverified | **F3 backfill re-verification sweep** |
| Invented failure shape (hallucination) | ③ verifier (deferred) — findings won't support the description |
| Two distinct shapes merged into mush | ② merge detection + ③ verifier |
| Cohesive-but-mislabeled cluster (wrong `fix`/SC) | ③ verifier refutes the **fix/SC mapping**, not just cohesion |
| SC coverage regresses on real code | ② `matrix:check` (the one thing it does catch) |

## Verifier protocol (F3, deferred — when autonomy is justified)

The earlier "N=3, majority veto, check cohesion" is upgraded — majority-of-3 on
*shared prose* is agreement-mush (correlated errors), and cohesion ≠ correctness:

- **Unanimous to auto-ship** (3/3 accept). The cost of a stale-quarantine is low;
  the cost of shipping a wrong pattern is the moat.
- **One verifier authors the shape from the findings alone**, then ship only if
  its independent label matches the proposed one — forces evidence-grounded
  disagreement instead of rationalizing vague prose.
- **Refute the `fix` and WCAG-SC mapping independently**, not only "do these
  findings share a shape." The `fix`/`wcag` fields are what reach the customer
  report. Until F3 ships, `fix`/SC prose changes go through the human queue even
  when membership is stable.
- **F3 also runs the one-time backfill sweep** over the retained substrate (above).

## Privacy & data-handling (was asserted-solved; now being enforced)

The raw export carries customer identifiers (`org_id`/`project_id`/element/urls +
raw prose). The distiller strips them after the k≥3 gate — **true** — but the
"raw export is gitignored, never committed" claim was **false**: there was no
ignore rule, and raw scan dumps sat untracked in the tree. Fixed:
`.gitignore` now excludes `raw-export*.json`, `data/clusters/_worklist-*.json`,
and `demo/**/raw-*.txt`. Still required before any **unattended** phase:

- a **commit pre-check** (CI) that fails if a raw-export/worklist pattern is staged;
- an explicit **egress policy** for the verifier: ③ fans anonymized findings out
  to N model calls — that is network egress the static path deliberately avoids.
  Define what the verifier may send (anonymized finding text only, never
  org/url/element) and where, before F3.

## Proposed resolutions

1. **Re-cluster trigger = new-signal, with a wall-clock floor.** Re-cluster when
   the export gains ≥1 new `org_id` — **and at least every T regardless**, so a
   quiet period can't silently freeze the corpus against a changing world.
   Replace the vague "when a human is the bottleneck" F3/F4 unblock with a
   **quantified** new-org-cadence number (reviews/week), named in F4.
2. **Cluster identity = asymmetric containment (≥0.7), quarantine-on-ambiguity**,
   split/merge → quarantine-retain. Pending the `avt_*` stability contract.
3. **Incremental / delta clustering is a first-class requirement (cost).** What is
   re-clustered is the **raw findings** (~635 today, growing monotonically), not
   the ~51 distilled patterns — so full re-cluster per new-org trigger is
   superlinear batch cost, and the more the flywheel succeeds the more each turn
   costs. Before F4's nightly loop: cluster only new findings against existing
   cluster centroids; full re-cluster only on the wall-clock floor or a measured
   drift threshold. (Offline batch, not user latency — deferrable, but named.)
4. **Verifier = unanimous, author-from-findings, refute fix/SC** + the backfill
   sweep (above).
5. **corpus-baseline tolerances = monotonic hard floor + bounded new-churn.** No
   blessed cluster disappears or drops tier (structural, via retain-last-good).
   Coverage = **distinct `avt_*` ids in the shipped union, deduped** (summing
   per-cluster counts double-counts retained-old + new). Bounded tolerance applies
   only to net-new churn; re-bless the baseline in the same PR as a deliberate
   corpus change.
6. **Detection coupling in the gate.** Recall cert re-run in ②; `eligibleToFlag`
   reads a live tier. A corpus change that moves certified detection re-blesses
   the recall certificate in the same PR.
7. **Aging signals.** Absence-driven retirement queue (M-run non-recurrence) +
   F3 re-verification backfill. Both human-gated.
8. **Quarantine + retirement queues have a named owner + an age SLA.** Alert when
   any item exceeds N runs; owner explicitly Can or Umut. *Honest limit:* on a
   2-person team the human review IS the throughput ceiling — which is precisely
   why F3–F4 autonomy is gated on cadence measured against that ceiling, not built
   speculatively.

## Build phases

**Now — the deterministic spine (human-triggered cadence):**
1. **F0** — corpus-baseline format + `corpus:baseline` / `corpus:check` (analog of
   `matrix:baseline`/`matrix:check`; neither exists yet) **and the recall-cert
   re-run wired into the gate**. *No model.*
2. **F1** — the **containment** identity matcher (split/merge detection,
   quarantine-on-ambiguity) + per-cluster provenance (`blessedByBatch`,
   `verifyStatus`) + retain-last-good merge + the **live-tier `eligibleToFlag`**
   fix. **Unit-test the monotonic invariant directly, including split/merge and the
   containment boundary.** *Gated on the `avt_*` stability contract.* *No model.*
3. **F2** — make the clustering pipeline (`extract-for-clustering` → cluster →
   `run-distill`) callable end-to-end. **This wires in the LLM clustering
   judgment** — it is *not* "deterministic, normal CI." It must **not auto-commit
   cluster files**; output stays human-reviewed until F3 gates it. **Add a
   clustering-stability exit criterion:** re-run clustering K times on identical
   input and measure membership churn / partition agreement; F2 ships only when
   agreement clears a floor (high variance stalls the wheel regardless of cadence —
   human-review covers safety, not throughput).

**Deferred — the autonomy (gated on Phase 1 detection live + measured cadence):**
4. **F3** — the verifier (unanimous / author-from-findings / fix-SC refute) + the
   backfill re-verification sweep + quarantine/retirement queues + the egress
   policy. The model enters here.
5. **F4** — the quantified new-signal + wall-clock trigger, incremental clustering,
   and the nightly job; full loop.

## Dependencies & sequencing

- Blocked on #1646 (engine + corpus must compose into `b8e` first).
- **`avt_*` id-stability contract** (per-defect, not per-occurrence) — a blocking
  unknown for F1; confirm against the upstream audit/export system.
- **Gated behind Phase 1 detection** — this is the *ingestion* link; growth shows
  value only once detection consumes a bigger corpus. (Detection already retrieves
  ~100 patterns over the 51 shipped — not a thin consumer; the second review's
  "build detection breadth first instead" was withdrawn once that was verified.)
- F3–F4 additionally gated on **measured, quantified** new-org cadence: build the
  unattended loop only when a human reviewing the diff is genuinely the bottleneck,
  expressed as a reviews/week number, not a vibe.

## Review log

**First review (2026-06-17, 3-agent):**
- **B1 (folded):** identity keyed on the LLM slug → re-keyed on `avt_*` membership.
- **B2 (folded):** split/merge vanished blessed clusters through green gates →
  explicit split/merge detection routes both sides to quarantine-retain.
- **B3 (fixed):** "gitignored, never committed" was false → `.gitignore` rules;
  commit pre-check + verifier egress policy required before F3.
- **Major (folded):** verifier checked cohesion only / majority-of-3 → unanimous +
  author-from-findings + refute fix/SC. F2 reframed as wiring in model judgment.
- **Scope (folded):** build F0–F2 cadence now, defer F3–F4.
- **Corrections:** slug is hand-authored, not derived; ledger field is
  `unclassified`.

**Second review (2026-06-18, grill + 3 skeptical verifiers — code-verified):**
- **Metric (folded):** symmetric Jaccard fights the corpus's own growth →
  **asymmetric containment of the blessed set (≥0.7)**; threshold stated;
  quarantine-on-ambiguity default.
- **Detection coupling (folded, the core finding):** gate ② omitted the recall
  certification, and `matrix:check` is byte-blind to corpus content → **recall-cert
  added to ②**; **`eligibleToFlag` must read a live tier** (frozen per-pattern tier
  poisoned the detection decision; the slug-orphan and tier-demotion were only
  "silent" because the cert test wasn't in the gate).
- **Aging (folded):** the design was silent on how patterns age → **absence-driven
  retirement** + **F3 re-verification backfill** of the pre-F3 substrate.
- **Cost (folded):** clustering input is the growing raw-finding set, not the 51
  patterns → **incremental/delta clustering named a first-class requirement**.
- **`avt_*` stability (folded as blocking unknown):** the matcher keystone rests on
  an unsourced "ids are stable" — the repo establishes opacity, not stability;
  generation is upstream → **cite the id contract before F1**; if per-occurrence,
  add defect-canonicalization first.
- **F2 (folded):** added a clustering-variance exit criterion (human-review covers
  safety, not throughput on a 2-person queue).
- **Withdrawn over-reaches (verifiers refuted the grill):** "feeding a 2-pattern
  detection layer" was false (51 patterns / ~100 retrieval; 2 is only the
  auto-flag-certified subset); "ToC says skip F0–F2" was wrong (building the
  machinery ≠ growing the corpus, and the safety rail is cheapest to build small) —
  **the F0–F2-now cut is retained**. "Symmetric-Jaccard death-spiral" was downgraded
  from a structural kill to a metric choice (split/merge already benched the growth
  case safely; containment removes the spurious quarantine). "Deduped coverage hides
  ghosts" was refuted (split detection catches the duplicate lineage upstream).
