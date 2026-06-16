# RFC Phase 1: Corpus → Agent Detection (the recall layer)

Status: **Design approved — ready to build (1a unblocked)** · Date: 2026-06-16
Companion to `docs/rfc-corpus-as-detection.md` (§4). Produced via a gated design
workflow (ground → 3 design approaches → adversarial critique → synthesis).

> Make the corpus *drive* detection of the long tail beyond the static 6-SC
> floor — without letting the recall layer erode the floor's precision. The
> whole design turns on one fix the critique surfaced: the floor's hard-won
> suppressors become a **deterministic pre-filter on the agent's findings**.

---

## The decision

A new **on-demand MCP tool `review_a11y`** with a two-step **retrieve → verify**
contract. The calling agent (which *is* the model) does the grounded read; the
tool itself calls no LLM (zero new API key, code never leaves the machine). The
static floor and the deterministic hook stay **byte-identical** — this is a new
recall layer *on top*, never a replacement.

```
agent → review_a11y({files|diff})
          → { staticFindings, corpusContext, suppressorMap, instruction }
agent → (grounded match in its own turn)
agent → review_a11y({verify, corpusFindings})
          → server-side gate stack → advisory `recall` findings
```

MCP-only for Phase 1 (not the hook): the recall step needs a model + a
suppressor walk + an adversarial pass per candidate — latency the hook's
FAST/FAIL-SAFE subprocess contract forbids. Hook grounding is **Phase 1.5**,
gated on the eval's precision floor holding.

## Why the naive design fails (the critique's core finding)

The dominant FP is **not** fabrication — a grounded model rarely invents line
numbers. It is **misclassification of real, correctly-located code**: a control
whose name is supplied off the call site. Syntactic gates are blind to it:

| Gate | Catches | Blind to the off-call-site FP? |
|---|---|---|
| closed-vocabulary (real patternId) | invented patterns | ✗ blind |
| verbatim quote + real line | fabricated locations | ✗ blind |
| confidence floor | low-confidence guesses | ✗ blind (it's textbook-high-confidence) |
| frequency-tier floor | rare patterns | ✗ *worse* — promotes the very-common ones |

`enforce.ts` encodes ~8 deterministic suppressors for this (`hasNameAncestor`/
Tooltip `:794`, `hasLabelAncestor` `:941`, `rendersOwnName` `:339`, `isToggleRole`
`:333`, `isHiddenOrUntabbable` `:490`, type-exempt `:457`, spread-props,
dynamic-children). The corpus encodes **none** — it's `failureShape` + `fix`
prose. Leaving precision to a single stochastic self-verify pass *inverts the
floor's entire FP discipline*.

## The FP discipline — 8 gates, deterministic precision wall

All server-side in `verify`, ordered cheapest/most-mechanical first so **model
trust is genuinely last**:

| # | Gate | Kind |
|---|---|---|
| G0 | Retrieval anchor — empty slice ⇒ no grounding, never invite a blind hunt | mechanical |
| G1 | Closed vocabulary — `patternId ∈ slice` or drop | mechanical |
| G2 | Mechanical validation — verbatim quote **at** the cited line + real JSX element | mechanical |
| **G3** | **Deterministic suppressor veto (keystone)** — run `enforce.ts`'s ancestor walk over the file → per-line `suppressorMap`; drop any finding on a suppressed line | **deterministic** |
| **G4** | **Abstention veto** — if `enforce` *considered* this control-type/SC at this line and returned null (opaque/dynamic/spread), that abstention vetoes the finding | **deterministic** |
| G5 | Confidence floor — only `high` surfaces | model |
| G6 | Frequency-tier floor — only `very-common`/`common` flag; `occasional` is context-only | mechanical |
| G7 | Adversarial self-verify — second pass: "does an ancestor name/label refute this?" — now belt-and-suspenders *behind* G3, not the sole defense | model |
| G8 | Advisory framing — every finding `enforcement:"warn"`, "likely — seen at N/27 orgs", never blocking | mechanical |

**G3 is the design.** Refactor `enforce.ts`'s suppressor predicates into a shared
`src/suppressors.ts`; build `suppressorMap(F)` from the *same* walk the floor
already runs. The map is both **fed to the model** (so it self-suppresses) **and
enforced server-side** (so it can't be bypassed). The precision wall moves from
"model behaves" back to "code checks" — the floor's whole philosophy, inherited.

## Retrieval (in-context, no vectors — ~100 patterns)

`retrieveSlice(F)` = union of three retrievers over `corpusPatterns()`, deduped
by id, capped **N=20** by frequency tier:
- **R1 by resolved component** (dominant) — `scan(F).resolved.resolutions`,
  *including opaque/trusted* (the long tail the floor can't AST-see); match
  `pattern.component` token-overlap with `resolution.name`/`host`.
- **R2 by SC present** — each SC in the floor findings pulls that SC's *other*
  failure shapes (what's behind a floor hit).
- **R3 by journey hint** — fixed path→tag map (`/checkout/`→checkout,
  `/(login|auth)/`→sign-in) boosts/filters by `journeyTags`.

G0: empty union ⇒ no grounding. Journey tags stay retrieval-internal.

## Provenance, dedup, determinism guard

- Add **`corpus-agent`** as the 5th `FindingProvenance` (`core.ts:47`), tagged
  `layer:"recall"` (floor findings are `layer:"floor"`). **Never produced by
  `scan()`** — only by `reviewA11y` after the agent returns.
- **Dedup** (after the static merge, reusing `dedupeEnforce`'s key widened):
  drop a corpus-agent finding when any static finding shares `file:line` + any
  WCAG SC. Plus self-dedup by `(file,line,patternId)`.
- **A missing floor finding is NOT permission to flag** — that's G4's job;
  dedup handles "floor already caught it," G4 handles "floor deliberately
  stayed silent."
- **Quarantine = the determinism guard.** Corpus-agent findings ride a separate
  `recall` field, never enter `scan()`'s `findings[]`, never set a CLI exit
  code, never `enforcement:"block"`. So `matrix:check` (which snapshots `scan()`
  output counts) is **structurally unable to see them** — a stochastic count can
  never flip the gate red. Zero change to `check.ts`.

## The eval — `pnpm recall:eval` (precision floor, not snapshot)

Separate from `matrix:check` by construction (count-snapshot for the floor;
precision-floor for the ceiling). Fixtures: `{file.tsx, expect | clean:true}`,
two families:
- **POSITIVE** — code genuinely exhibiting a pattern the floor *misses* → must
  surface (drives recall).
- **NEGATIVE / hard decoys (the precision spine)** — Tooltip-titled IconButton,
  FormLabel-wrapped input, `rendersOwnName` wrapper — the *same components* as
  positives, so precision is tested under realistic ambiguity (these exercise
  G3/G4/G7) → must surface **zero**.

K=5 samples/case. **Gate = Wilson lower-bound of precision ≥ floor** (not a point
estimate — a K=5 point estimate is itself flaky). Recall is reported + trend-
tracked, only soft-floored. The eval drives the **exact shipped path**
(`review_a11y` → `verify`), so it certifies the deployed channel, not a proxy.

## Build phases (each independently shippable)

1. **1a** — refactor `enforce.ts` suppressors into `src/suppressors.ts` (zero
   behavior change; `matrix:check` stays green). *No model.*
2. **1b** — `buildSuppressorMap(F)` from the existing ancestor walk + add
   "considered-and-skipped" markers to `enforceContent` (the G4 abstention
   signal). Deterministic unit tests.
3. **1c** — `retrieveSlice(F)` (R1/R2/R3 + G0); snapshot-test the pattern-id set.
   *No model.*
4. **1d** — `corpus-agent` provenance + `layer` tag + widened dedup; quarantine
   into the `recall` field (unit test: no corpus-agent finding moves the exit code).
5. **1e** — register `review_a11y`; implement the server-side G0–G8 stack.
6. **1f** — `experiments/corpus-recall/` fixtures + `pnpm recall:eval` (Wilson
   floor, K=5) against the real path; gate `review_a11y` default-on behind it.
7. **1.5** *(deferred)* — corpus-ground the hook, only after 1f holds.

Note 1a–1d are deterministic and ship with normal CI; the model only enters at
1e. The precision spine exists *before* the first grounded call.

## Resolved decisions (approved 2026-06-16)

1. **Precision floor = 0.95 Wilson lower-bound.** Ratchet up with data.
2. **G4 abstention-veto is in Phase 1 scope** (sequenced in 1b). Accept the
   `enforce.ts` contract change; `matrix:check` guards the regression risk.
3. **`recall:eval` runs nightly, non-blocking.** Promote to per-PR only once
   precision proves stable.
4. **`occasional` tier stays context-only** (N=20 cap + G6). Revisit only with
   eval evidence.
