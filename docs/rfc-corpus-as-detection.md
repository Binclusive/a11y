# RFC: Corpus as Detection — closing the two broken links

Status: **Draft** · Author: derived with Claude · Date: 2026-06-15

> The engine is a precision floor. The corpus is a frozen photo wired to nothing.
> This RFC makes the corpus a *living detection asset*: one canonical store, a
> corpus-grounded agent that raises recall beyond the static rules, and an
> ingestion arc so every audit deepens the moat automatically.

---

## 1. Context — the two broken links

The checker has two parts that should reinforce and currently don't:

- **Detection** (`src/core.ts`, `src/enforce.ts`) — static AST analysis. Fires on
  **6 WCAG SCs** (1.1.1, 1.3.1, 2.1.1, 2.4.4, 3.3.2, 4.1.2) — ~12% of the AA
  surface. High precision, deliberately low recall. This is correct and stays.
- **Corpus** (`src/corpus.ts`, `data/corpus/`, `data/corpus-snapshot.json`) — real
  audit data (27 orgs). The differentiator.

The links between them:

```
   audits ──①──▶ CORPUS ──②──▶ detection
            ▲ manual,          ✗ severed:
            no feedback         enrichAll is a 1:1
            (ingestion)         annotation map; detection
                                reads zero corpus at runtime
```

**Proof link ② is severed:** `enrichAll = findings.map(enrich)` (`corpus.ts:376`);
`enrich` returns `{...finding, corpus}` (`corpus.ts:372`). It never adds, removes,
or filters a finding. `enforce.ts`/`core.ts` reference the corpus only in comments
and message strings — no runtime lookup. A new corpus pattern therefore changes
*nothing* about what is found.

**Consequence:** fixing ingestion (①) yields zero product improvement while ② is
severed — a richer warehouse with no doors. **② is the keystone.**

## 2. Goals / non-goals

**Goals**
- One canonical corpus store; retire the hand-authored snapshot.
- A detection path where the corpus raises recall beyond the static 6 SCs.
- An ingestion arc so new audits reach the corpus without a full manual re-run.
- Preserve: the static floor's precision, determinism, k≥3 anonymization, "code
  never leaves the machine."

**Non-goals**
- Replacing the static engine. It remains the deterministic floor.
- Vector databases / embeddings infra (the corpus is ~100 patterns / 15 SCs —
  small enough to pass relevant slices in-context; see §4).
- Auto-merging new audit data without human review of genuinely novel shapes.

## 3. Phase 0 — the canonical store (prerequisite)

Today two stores disagree: `corpus-snapshot.json` (10 SCs, hand-authored, 5 of 10
tiers miscalculated, the runtime *gate* for `source:"audit"`) and
`data/corpus/patterns-*.json` (15 SCs, machine-distilled, the *detail*). Five
distilled SCs (1.3.5, 1.4.3, 2.4.6, 2.4.7, 3.2.5) are loaded but **unreachable**
because the snapshot has no entry to gate them.

**Decision: the distilled patterns are the single source of truth. Delete the
snapshot.**

- The distiller (`src/distill/`) emits a derived per-SC summary
  (`data/corpus/sc-summary.json`): `{ sc → { tier, orgs, patternCount } }`,
  computed from the patterns (max/aggregate over distinct orgs), never hand-typed.
- Preserve the **per-pattern distinct-org count** through distillation (today only
  the `frequencyTier` bucket survives — `distill.ts` strips org_id after the k≥3
  gate). Write it into each pattern so provenance is auditable from the shipped file.
- `corpus.ts` gates `source:"audit"` on the presence of distilled patterns for the
  SC, not on the snapshot. Result: all 15 SCs reachable; the 5 wrong tiers vanish
  (computed, not typed); org counts self-sync.
- One `fix` authority per granularity: pattern-level `fix` from the distiller;
  SC-level fix *derived* (or dropped — `resolveDisplay` already suppresses it for
  axe findings, `corpus.ts:474`).

This is a refactor with a hard correctness check: after it, a finding on each of
the 5 stranded SCs must enrich as `source:"audit"`, and 1.1.1/2.1.1 must report
`very-common` (currently mis-shipped as `common`).

## 4. Phase 1 — link ② : corpus-grounded detection (the keystone)

The static engine can't consume the corpus (each pattern would need a hand-written
AST rule — that is how the 6 SCs got there). The agent face can.

**Mechanism — corpus-as-context (RAG without the infra).** A new MCP tool /
hook mode reviews a file or diff with the relevant corpus slice as grounding:

```
review_a11y({ file | diff })
  1. static pass  → the deterministic findings (unchanged floor)
  2. retrieve     → corpus patterns relevant to this file:
                    by resolved components (resolve-components.ts already knows
                    them), by the SCs in play, by journey hints in the path
  3. ground       → ask the model: "here are real failure patterns seen at N/27
                    orgs; does this code exhibit any the static pass missed?"
  4. merge        → static findings (provenance:"enforce"/"jsx-a11y") +
                    corpus-agent findings (provenance:"corpus-agent", carrying the
                    pattern id + org frequency), deduped by (file,line)
```

**Why in-context, not embeddings:** ~100 patterns across 15 SCs. The relevant
slice for one file (a handful of components × their SCs) is a few KB — pass it
whole. Embeddings/vector stores are premature until the corpus is 10–100× larger.
(Precedent: Semgrep Assistant, Copilot Autofix, RAG code-review all pass curated
context; retrieval sophistication scales with corpus size, not before.)

**Precision discipline carries over.** Corpus-agent findings are *recall*, not
floor — they must be marked as a distinct provenance and held to the same
"app-owned content clearly absent / high-confidence" bar the enforce pass uses, so
the agent extends coverage without reintroducing the false positives the static
floor was designed to avoid. The regression gate (`matrix:check`) extends to cover
the corpus-agent path so its recall is itself guarded.

**This is the line that makes "update corpus → find more" true:** a pattern added
to the canonical store is in the retrieval slice on the very next review — no
rule-writing, no release.

## 5. Phase 2 — link ① : the ingestion flywheel

Today: manual export → LLM cluster → distill → commit; raw audit DB external (PII).
The expensive step is LLM clustering of every finding.

**Decision: incremental cluster-assign.** New findings are matched against existing
cluster centroids (the failure-shape prose already in `clusters-<SC>.json`); only
findings that match nothing become a small "novel" worklist for human/LLM review.
The committed cluster files stay the reviewable, frozen fixtures (determinism +
anonymization preserved); incremental assignment only *appends*.

- k≥3 anonymization gate unchanged — a pattern ships only once ≥3 distinct orgs
  back it.
- The b8e MCP seam (existing audit-ticket tools) is the natural intake: a closed
  audit's findings flow to the distiller instead of a hand-run SQL export.

Phase 2 is sequenced last on purpose: it is worthless until ② consumes the corpus,
and trivial to design once the canonical store (Phase 0) exists.

## 6. Final state

```
        canonical corpus store  (Phase 0: computed, single source, all SCs live)
         /                       \
   ② DETECTION (Phase 1)     ① INGESTION (Phase 2)
   agent reads corpus as      audits → incremental
   context → finds long tail   cluster-assign → store
         \                       /
          two faces: internal audit speed + agent product
                       │ drive more audits ┘
```

Detection becomes two-layer: static **floor** (precise, ~6 SCs, deterministic) +
corpus **ceiling** (recall, climbs toward audit-level, grounded). The moat
compounds every audit. Customer code stays local; the corpus the agent reads is
already anonymized.

## 7. Open calls — resolved here, flag if you disagree

| # | Call | Decision |
|---|------|----------|
| 1 | Snapshot: fix or retire? | **Retire.** Derive SC-summary from distilled data. Hand-fixing re-arms the same gun. |
| 2 | Retrieval: embeddings or in-context? | **In-context** at current scale; revisit at 10× corpus. |
| 3 | Where does corpus-agent detection run? | **Locally** (MCP/hook). Code never leaves; corpus is local + anonymized. |
| 4 | Static engine changes? | **None.** It is the floor; all new recall is the agent layer. |
| 5 | Sequencing | **0 → ② → ①.** Detection is the keystone; ingestion is worthless before it. |
| 6 | Guarding the new recall path | Extend `matrix:check` to the corpus-agent path so recall is regression-gated like the floor. |

## 8. Risks

- **Corpus-agent false positives** erode the precision the floor protects → distinct
  provenance, high-confidence bar, regression-gated, and surfaced as "likely / seen
  at N orgs" not hard blocks.
- **Determinism** of an LLM detection step → the *corpus* (its context) is
  deterministic and reviewed; treat agent recall as advisory, never a build-failing
  gate by default.
- **PII** → anonymization stays upstream of anything shipped; the agent reads only
  the k≥3 anonymized store.
