# a11y-checker — the map

The one document that answers: *what is this machinery, how does it find and
match things, which code does what, and how is it organized.* Read it once and
you can explain the whole project from memory.

---

## 1. What it is — say this to a coworker

**One sentence.** It's a local accessibility checker for React code that doesn't
just use generic lint rules — it checks your code against a corpus of real
accessibility failures from Binclusive's audits, and it reaches the
design-system components a normal linter is blind to.

**One paragraph.** You point it at a folder of `.tsx` files. For every component
on screen it works out what HTML element it really is. Then it looks for problems
two ways: the normal structural lint pass, plus a second pass that checks the
*content you passed in* (names, labels, alt) — which catches bugs hiding inside
"trusted" library components. Those two passes are deterministic and make up the
**floor** — they catch the *structural absence* of a name/alt. On top of the floor
sits a second, distinct detection path: the **recall layer** — a corpus-grounded
agent that catches the *semantic* "present-but-wrong" failures the floor is blind
to (a link that says "click here", an `alt` that's a filename). Every finding is
matched against the audit corpus, so it tells you not just *that* something's wrong
but *how common* that failure is in the real world and the fix that worked. It runs
locally, plugs into AI coding tools, and never sends your code anywhere.

**The one-line "how."** *Resolve what each component is → look for problems two
ways (the floor) → let a gated agent recall what the floor can't see → match each
finding to the corpus.* Everything else is detail under those moves. The floor is
the deterministic spine; the recall layer is advisory and quarantined — it can
*never* move the floor's exit code (§2a).

---

## 2. The machinery — one scan, traced end to end

This is the whole thing. When you run `a11y-checker check src/`, here is literally
what happens, in order, with the real files and functions.

```
 a11y-checker check src/                                         [src/cli.ts → runCheck]
        │
        ▼
 1. collect the .tsx files                                       [collect.ts → collectTsx]
        │
        ▼
 2. SCAN — the conductor                                         [core.ts → scan]
        │
        ├─ 2a. load the contract (binclusive.json, or null)      [config-scan.ts → contractForFiles]
        │                                                         [contract.ts → parseContract]
        │
        ├─ 2b. RESOLVE every component → its host element        [resolve-components.ts → resolveComponents]
        │        for each <Capitalized> used in JSX, try in order:
        │          0 declared   you wrote it in binclusive.json
        │          1 registry   known design-system map          [registry.ts → lookupRegistry]
        │          2 trace      read the component's source,      [source-trace.ts → traceComponent]
        │                       infer the single forwarding host    ├─ follow @scope/pkg imports [workspace-resolve.ts]
        │                                                            ├─ follow tsconfig path aliases [tsconfig-aliases.ts]
        │                                                            └─ follow #app/* imports        [imports-resolve.ts]
        │          3 opaque     couldn't tell → bucket it honestly
        │                       (trusted | icons | structural | declare)
        │        ⇒ returns: the wrapper→host MAP + the COVERAGE buckets
        │
        ├─ 2c. PASS ONE — structural lint                        [core.ts → buildESLint]
        │        run eslint-plugin-jsx-a11y over the resolved map (SCORED_RULES)
        │        each hit → normalize + map rule→WCAG SC          [wcag-map.ts → wcagForRuleId]
        │        drop false positives on injected / aria-hidden lines  [trans-suppress.ts]
        │
        ├─ 2d. PASS TWO — call-site content check                [enforce.ts → enforceContent]
        │        recognize the control TYPE at the call site (classify):
        │          module-scoped resolved host → registry → name heuristic
        │        check the app-owned content (evaluate) with the conservatism guards
        │        ⇒ catches opaque/"trusted" components pass one can't see
        │
        └─ 2e. DEDUPE — drop pass-two hits pass one already found [core.ts → dedupeEnforce]
                 ⇒ returns: { findings, coverage, resolved, contract }
        │
        ▼
 3. ENRICH — match each finding to the corpus                    [corpus.ts → enrichAll]
        by its WCAG SC → attach tier (how common) + orgs + fix + distilled patterns
        │
        ▼
 4. REPORT — coverage buckets, findings by file, tier rollup,    [cli.ts → formatCoverage / formatFinding]
    blocking vs warning; exit 1 if anything blocking fired
```

If you can narrate those four steps — **collect → scan (resolve, two passes,
dedupe) → enrich → report** — you've explained the floor's machinery. The recall
layer (§2a) is a separate, advisory path that sits *beside* this pipe, not inside
it.

### The second producer — rendered DOM, for source-less / non-React pages

Steps 2 (scan) and 3–4 (enrich/report) above are about *one* finding producer:
the `.tsx` source scan. There is a **second producer** for when there is no React
source — a deployed site, an ASP.NET/Razor app, a plain HTML page. It swaps the
front of the pipe and reuses the back unchanged:

```
 a11y-checker check-url <target>                                 [src/cli.ts → runCheckUrl]
        │   target = http(s):// | file:// | bare local path (→ file://)
        ▼
 1'. RENDER the page in real Chromium + run axe-core              [collect-dom.ts → scanUrl]
        │     read each violation's WCAG SC straight off axe `tags` (`wcag111` → 1.1.1)
        │     anchor each finding on its CSS `selector`, provenance: "axe"
        ▼
 3. ENRICH — the SAME corpus match by WCAG SC                     [corpus.ts → enrichAll]
        ▼
 4. REPORT — grouped by axe rule, anchored on selector,           [cli.ts → formatUrlFinding]
    tagged (rendered-DOM / axe); same tier rollup + block/warn gate
```

Same `Finding` type, same `enrichAll`, same enforcement gate — only the *source*
of the findings differs (a rendered page vs. `.tsx` files). A real browser sees
what static JSX never can: **color-contrast**, computed ARIA roles, and
layout-dependent rules. The trade is that the DOM path has no components or
imports, so it inherits the corpus's SC-level value but **not** pass two's
component-level recall — the two producers are complementary, not equal. (The
full rationale is `.decisions/0001-rendered-dom-adapter.md`.)

### 2a. The recall layer — the second DETECTION path (corpus → agent)

Everything above is the **floor**: deterministic code that catches the *structural
absence* of a name/alt. The floor cannot see a name/alt that is **present but
semantically wrong** — `<a>click here</a>` (link text present, but generic),
`<img alt="IMG_4821.jpg">` (alt present, but a filename). jsx-a11y is satisfied,
enforce is satisfied, and yet these are the most common real-world content
failures in the corpus. Catching them needs a *reading* of the code, not a
structural rule — so the recall layer is a separate path, not a third pass inside
`scan()`.

It ships as one MCP tool, `review_a11y`, run in **two steps** with the agent in
the middle (`.decisions/0003-deterministic-shell-stochastic-core.md` — *"the model
PROPOSES, deterministic code DISPOSES"*):

```
 review_a11y { dir }                                              [review.ts → reviewA11y → retrieve]
        │   RETRIEVE step — pure, no model
        ▼
   build the corpus SLICE that grounds this review               [retrieve.ts → retrieveSlice]
     + the per-line suppressor facts (do-not-flag lines)         [suppressor-map.ts → buildSuppressorMap]
     + the deterministic static-floor findings
        │
        ▼
   the AGENT reads the slice and NOMINATES candidates            [the only place a model runs]
     closed vocabulary: only slice patternIds, each with a
     verbatim code quote + a line + an adversarial self-          (the self-justification is G7 — the
     justification for why it's a real failure                     agent's own step, not a server gate)
        │
        ▼
 review_a11y { verify:true, files, candidates }                  [review.ts → reviewA11y → verify]
        │   VERIFY step — deterministic, server-side
        ▼
   recompute the static facts from scratch (NEVER trust a fact    [review.ts → buildStaticFacts]
   the model echoed back), then run the G0–G6 gate stack:
     G0 ANCHOR        empty slice ⇒ no grounding ⇒ everything dies here
     G1 CLOSED-VOCAB  patternId must be a slice pattern (per-file slice)
     G2 MECHANICAL    codeQuote must be a verbatim substring AT a real JSX line
     G3 SUPPRESSOR    drop if the floor's suppressor map vetoes that line
     G4 ABSTENTION    drop if the floor CONSIDERED that line+SC and declined
     G5 CONFIDENCE    drop unless confidence === "high"
     G6 TIER FLOOR    drop unless the slice pattern is eligibleToFlag
        │
        ▼
   survivors → DEDUPE against the floor → shape as advisory       [review.ts → dedupeRecall / toRecallFinding]
   recall Findings (G8 — the framing of a survivor, not a veto)
```

`GateId` is exactly `G0 | … | G6` — **G7 and G8 are not server gates.** G7 is the
agent's own adversarial self-justification (its step, not the server's); G8 is the
*shaping* of a survivor into an advisory `Finding`, not a veto.

**QUARANTINE — the floor is byte-identical whether or not recall runs.** Recall
findings are advisory by construction: `provenance: "corpus-agent"`, `layer:
"recall"`, `enforcement: "warn"`. They are deduped against the floor
(`dedupeRecall`), then ride a **separate** `recall` field on `ScanResult`. They
**never** enter `scan().findings` and **never** touch the exit code — `scan()`
itself never produces a `corpus-agent` finding. This is the line that keeps the
real-world regression gate (`matrix:check`) trustworthy: a stochastic count can
never flip a deterministic gate.

---

## 3. The five jobs, and the code that does each

The whole `src/` tree groups into five jobs plus delivery — and DETECT now has two
halves: the deterministic **floor** (Job 2) and the corpus → agent **recall**
ceiling (Job 2b), each with its own certification. ~12k lines total.

### Job 1 · RESOLVE — "what element is this component, really?"
The hardest and most important part. Turns `<FancyButton>` into "it's a `button`."

| File | What it does |
|---|---|
| `resolve-components.ts` | **The orchestrator.** For each component used, tries declared → registry → trace → opaque; builds the wrapper→host map + the honest coverage buckets. |
| `registry.ts` | Known design-system mappings (MUI/Radix/Chakra/antd → host). Pure data, the fast path — no tracing needed. Also knows icon libs + structural plumbing. |
| `source-trace.ts` | **The tracer.** Follows an import to the component's source file, reads its syntax tree, and if it forwards props to one element, records that as the host (+ any role). |
| `workspace-resolve.ts` | Follows a monorepo `@scope/pkg` import to its real source file. |
| `tsconfig-aliases.ts` | Tells whether an import is the repo's own code via a tsconfig `paths` alias (so it isn't mistaken for a UI library). |
| `imports-resolve.ts` | Follows a `package.json` `#app/*` subpath import to its source. |

### Job 2 · DETECT (the FLOOR) — "which elements are STRUCTURALLY broken?"
The deterministic spine. Catches the *absence* of a name/alt. Owns the exit code.
| File | What it does |
|---|---|
| `core.ts` | **The conductor — `scan()`.** Runs resolve, then pass one (jsx-a11y), then pass two (enforce), dedupes, returns `{ findings, coverage, … , recall }`. The `recall` field is the quarantine slot — `scan()` itself never fills it. Start here to read the system. |
| `enforce.ts` | **Pass two.** The corpus-driven call-site content check + every conservatism guard. The biggest single file — this is the floor's recall win and the false-positive discipline. Exports `buildResolvedHosts` + `enforceContentWithAbstentions`, which the recall layer reuses as G3/G4 inputs. |
| `suppressors.ts` | **The floor's shared suppressor predicates** (is the `type` exempt? is it hidden? is it a label/name-injecting container?), lifted into their own module (ADR 0003) so the recall layer can reuse them *unchanged* as a precision pre-filter. |
| `trans-suppress.ts` | Computes the line ranges where a content finding is a false positive (runtime-injected children like `<Trans>`, or `aria-hidden`), so neither pass fires there. |
| `wcag-map.ts` | Maps each jsx-a11y rule id → its WCAG SC. The bridge that lets a finding be matched to the corpus. |
| `collect-dom.ts` | **The second producer.** Renders a URL in real Chromium (Playwright) and runs axe-core against the live DOM — for source-less / non-React pages. Reads the WCAG SC off axe `tags` (so no rule-id crosswalk), anchors each finding on a CSS selector, tags it `provenance: "axe"`, then hands off to the same `enrichAll`. |

### Job 2b · RECALL (the CEILING) — "which present-but-WRONG content did the floor miss?"
The corpus → agent path (§2a). Advisory, quarantined, never gates the build.
| File | What it does |
|---|---|
| `review.ts` | **The deterministic shell — `reviewA11y`.** The two-step `review_a11y` tool: RETRIEVE (slice + suppressor facts + static findings) and VERIFY (the server-side **G0–G6** gate stack that disposes of the agent's nominations). `buildStaticFacts` recomputes the floor's facts so the server never trusts a model-echoed value; `dedupeRecall` + `toRecallFinding` quarantine the survivors. |
| `retrieve.ts` | **The grounding — `retrieveSlice`.** Builds the closed-vocabulary corpus slice four ways (R1 token overlap, R2 by-SC-of-a-finding, R3 journey path, R4 content-inspection), capped at `SLICE_CAP` and tier-ordered. Owns `CERTIFIED_RECALL_PATTERN_IDS` (the proven-precise auto-flag set) and the `eligibleToFlag` tier floor (occasional-tier = context-only). |
| `intrinsic-elements.ts` | **R4's eyes.** A pure walk that keeps the *lowercase intrinsic* tags (`<img>`, raw `<a>`) R1–R3 never see (they only read imported, capitalized JSX), reading a content-COARSE signal (present/dynamic/missing — never the literal string) that `retrieveSlice`'s R4 clause maps to pattern-ids. |
| `suppressor-map.ts` | **The G3 input.** Runs the floor's *same* ancestor-suppressor walk (`buildSuppressorMap`) and records, per JSX line, which floor suppressors fire there — so a recall nomination on a suppressed line is vetoed by the same logic the floor uses. |

### Job 3 · ENRICH — "how much should I care?"
| File | What it does |
|---|---|
| `corpus.ts` | Loads the snapshot + distilled patterns; for each finding, attaches the corpus evidence by SC (tier, how many orgs, the fix, the failure shapes seen in the wild). |

### Job 4 · CONTRACT — "what does THIS repo's policy say?"
| File | What it does |
|---|---|
| `contract.ts` | The `binclusive.json` shape + the boundary parser (loud on required fields, lenient on the optional escape hatch). |
| `config-scan.ts` | Finds the nearest `binclusive.json` at/above the files and turns it into per-scan declarations + the block/warn enforcement decision. |
| `commands.ts` | `init` / `learn` / `gen` as filesystem operations (detect stack → write contract → regenerate the AI block). |
| `detect-stack.ts` | Detects framework, router, design system, and language from `package.json` + disk layout. |
| `agents-block.ts` | Renders the corpus rules into the managed `AGENTS.md` / `CLAUDE.md` block and splices it in (one-way generation; drift-guarded). |

### Job 5 · DISTILL — "build the corpus from real audits" (offline factory)
| File | What it does |
|---|---|
| `distill/distill.ts` | **The deterministic distiller.** Applies the k≥3-org gate, assigns tiers, derives journey tags, and emits the no-silent-drops ledger. |
| `distill/cluster-assignments.ts` | Loads the frozen LLM cluster files (the offline judgment, committed as data). |
| `distill/normalize-sc.ts` | Cleans the messy `wcag_criterion` field (`"wcag244"`, `"WCAG 2.4.4"`, axe ids) → one canonical SC. |
| `distill/journey-category.ts` | Collapses bilingual free-text journeys → a closed 14-category enum. |
| `distill/extract-for-clustering.ts` | The input side: strips identifiers and produces the worklist the LLM reads to author the cluster files. |
| `distill/run-distill.ts` | The runner: raw export + cluster files → the shipped `patterns-<SC>.json` + `ledger-<SC>.json`. |

### Delivery — "get the corpus to the developer / the AI"
| File | What it does |
|---|---|
| `cli.ts` | The `a11y-checker` command: `check`, `check-url`, `init`, `learn`, `gen`, `mcp`, `hook` + the report formatting (source + rendered-DOM). |
| `mcp.ts` | A local stdio MCP server exposing `check_a11y` / `check_url` / `get_a11y_rules` / `learn_a11y_rule` / **`review_a11y`** (the two-step recall tool) to Cursor/Copilot/Claude. |
| `hook.ts` | **The Phase-1.5 auto-whisper hook** (`PostToolUse`). On the just-edited file it whispers TWO things: (1) the precise **floor** findings ("fix these now"), and (2) a distinct **advisory recall self-check** — the floor-missed semantic shapes, scoped to the certified patterns and suppressor-aware. The deterministic hook can't run the agent's propose→verify loop, so it hands the in-loop model the same grounding `review_a11y`'s retrieve step produces and asks it to self-review — closing the semantic gap inside the same edit turn. |
| `index.ts` | The public API barrel — re-exports everything for programmatic use. |
| `collect.ts` | Recursively finds the `.tsx` files to scan (skips generated dirs). |

### Certification — "is the recall layer actually precise?"
The recall layer earns its trust the same way the floor does: a committed gate.
| File | What it does |
|---|---|
| `experiments/corpus-recall/` | The recall-layer eval harness (`pnpm recall:eval`). Three **blind** grounding passes (model nominations produced WITHOUT sight of the labels) are scored through the **real** `reviewA11y` verify gates (G0–G6) and pooled. Separate from `matrix:check` by construction: that's a count-snapshot gate for the *floor*; this is a precision-floor gate for the *ceiling*. They never share a baseline. |
| `test/recall-certification.test.ts` | The gate, inside `pnpm test`. It re-scores the **committed** blind nominations deterministically — **no model is called** — through the real verify path, and FAILS the build if precision moves. The gate is a **Wilson 95% lower bound ≥ 0.95** (today: point precision **1.000**, 93/93 surfaced findings correct; Wilson LB **0.9603**; 0 FPs on 19 hard decoys). The committed artifacts ARE the certificate. |

**The certified auto-flag set.** `CERTIFIED_RECALL_PATTERN_IDS` is exactly the
patterns proven precise through these gates — today three: `2.4.4-generic-link-text`,
`2.4.4-noisy-or-wrong-name`, `1.1.1-filename-or-generic-alt` — reachable on both
imported components AND (via R4) intrinsic elements. This is what the Phase-1.5
hook surfaces.

### The detection SCOPE — three tiers, honestly drawn

What this checker can *catch* falls into three tiers, by how trustworthy each is:

1. **The deterministic floor** — jsx-a11y + enforce, ~6 WCAG SCs. Structural
   absence of a name/alt. Owns the exit code. Always on, never advisory.
2. **The certified auto-flag recall** — the 3 `CERTIFIED_RECALL_PATTERN_IDS`,
   proven through the Wilson gate. What the edit-time hook surfaces. Advisory.
3. **The gated-agent recall** — `review_a11y` retrieves ~100 distilled patterns
   and an agent may nominate *any* of them; the G0–G6 stack disposes. Precision is
   **uncertified** beyond the 3.

**Why the certified set is narrow — and at a real ceiling, not a gap to fill.** A
pattern is honestly certifiable only where bad **app-supplied content/state** hits
a **trusted component shell** the component can't fix — link text and alt quality
are exactly that (the app pours a bad name into a shell). Most other patterns
aren't honestly unit-fixture-able: they're **floor-owned** (the deterministic pass
already catches them), **self-managed by the trusted component** (an antd `<Tabs>`
auto-selects its first pane and renders `aria-selected` at runtime, so a static
"selected-state-missing" nomination on it is a *false positive* — it lives as a
hard negative in the cert), or **page-context** (a heading skip can't be shown in
one snippet). Certifying those is *deferred, not faked*. This is a deliberate,
documented scope.

---

## 4. How it's organized

**The layering — pure core, thin IO shell.** The logic that decides things
(resolve, enforce, retrieve, the recall gates, distill, parse, render) is pure and
unit-tested. The files that touch disk or the network (`cli.ts`, `commands.ts`,
`mcp.ts`, `hook.ts`, `run-distill.ts`) are thin shells around that pure core. Tests
exercise the core; the shells just wire it up.

**The deterministic-shell rule (ADR 0003).** Every stochastic capability is
wrapped in deterministic code on both sides: the model only ever runs as the
*agent between* `review_a11y`'s two pure steps, and its output is disposed of by
the G0–G6 gates before anything is emitted. The model PROPOSES; deterministic code
DISPOSES. This is why the recall layer can be advisory-but-trusted, and why the
floor's exit code never depends on a model.

**The dependency direction.** Everything flows toward `core.ts → scan()`. If you
only read one file, read that one — it calls everything else in order.

**Boundaries are parsed, never trusted.** Three places take in outside data —
the `binclusive.json` on disk (`contract.ts`), the corpus JSON (`corpus.ts`), the
cluster files (`cluster-assignments.ts`). Each is loaded as `unknown` and narrowed
by hand, failing loud on a broken shape. No `as any` smuggling bad data inward.

**The directory tree, annotated:**
```
packages/a11y-checker/
├── src/
│   ├── cli.ts                 the command + the report      ← delivery
│   ├── core.ts                scan() — THE CONDUCTOR        ← read this first
│   ├── resolve-components.ts  wrapper → host orchestrator   ← job 1
│   ├── registry.ts            known-library host map        ← job 1 (data)
│   ├── source-trace.ts        the AST tracer                ← job 1
│   ├── workspace-resolve.ts   /  tsconfig-aliases.ts  /  imports-resolve.ts   ← job 1 (alias resolvers)
│   ├── enforce.ts             pass two + the FP guards      ← job 2 (the floor's recall win)
│   ├── suppressors.ts         shared suppressor predicates  ← job 2 (reused by recall as G3/G4)
│   ├── trans-suppress.ts      false-positive line ranges    ← job 2
│   ├── wcag-map.ts            rule id → WCAG SC             ← job 2 (bridge)
│   ├── collect-dom.ts         render URL + axe-core         ← job 2 (the second producer)
│   ├── review.ts              review_a11y + G0–G6 gates     ← job 2b (the recall shell)
│   ├── retrieve.ts            the corpus slice (R1–R4)      ← job 2b (grounding + certified set)
│   ├── intrinsic-elements.ts  R4 intrinsic-tag walk         ← job 2b (R4's eyes)
│   ├── suppressor-map.ts      per-line G3 suppressor facts  ← job 2b
│   ├── corpus.ts              match findings to the corpus  ← job 3
│   ├── contract.ts / config-scan.ts / commands.ts / detect-stack.ts / agents-block.ts   ← job 4
│   ├── distill/               the offline corpus factory    ← job 5
│   ├── mcp.ts / hook.ts       AI delivery surfaces          ← delivery (hook = Phase 1.5)
│   └── index.ts               public API barrel
├── data/
│   ├── corpus-snapshot.json   seed SC-level frequencies (643 findings / 26 orgs)
│   ├── clusters/clusters-<SC>.json   frozen LLM failure-shape groupings (input)
│   └── corpus/
│       ├── patterns-<SC>.json shipped distilled patterns (what the checker reads)
│       └── ledger-<SC>.json   no-silent-drops drop counts
├── plugin/                    the Claude Code plugin (MCP + hook bundled)
├── experiments/
│   ├── corpus-recall/         the recall-layer eval (blind passes + Wilson gate)
│   └── stack-matrix/          the SHA-pinned real-repo regression gate (the floor)
├── test/                      unit tests + fixtures (the pure core)
│   └── recall-certification.test.ts   re-scores the committed nominations (no model) — the build gate
└── docs/                      this map + the decks
```

---

## 5. The data (the corpus)

The corpus is real audit data, processed offline into something the checker can
ship. Three files per WCAG criterion, in two directories:

- **`data/clusters/clusters-<SC>.json`** — the *input*. An LLM grouped raw findings
  into failure shapes, once, offline, and that judgment is frozen here as data
  (finding id → cluster, plus generic English prose). The model never runs in the
  shipped pipeline — this is the **determinism boundary**.
- **`data/corpus/patterns-<SC>.json`** — the *output* the checker reads. Anonymized,
  k≥3-org-gated failure patterns with frequency tiers.
- **`data/corpus/ledger-<SC>.json`** — the receipt: everything dropped (junk, below-k)
  is counted, never silently lost.
- **`data/corpus-snapshot.json`** — the seed SC-level frequency table (how many of
  the 26 orgs hit each criterion) the enforcement defaults read from.

**The privacy rule, in the code:** a pattern only ships if 3+ different orgs hit it
(`MIN_ORGS` in `distill.ts`); org ids are read only for that gate, then stripped.

---

## 6. The vocabulary (use these words)

| Word | Means |
|---|---|
| **wrapper / host** | a wrapper is your component (`<SubmitButton>`); its host is the real element it renders (`button`). Resolving = finding the host. |
| **the four provenances** | how a host was found: `declared` (you said so) · `registry` (known lib) · `trace` (read the source) · `opaque` (couldn't). |
| **the opaque buckets** | when opaque, why: `trusted` (known-good lib) · `icons` · `structural` (plumbing) · `declare` (the only real gap). |
| **pass one / structural** | eslint-plugin-jsx-a11y over the resolved map — checks element structure. |
| **pass two / enforce** | the call-site content check — checks the name/label/alt you passed, and reaches opaque/trusted components. |
| **the floor** | the deterministic spine: jsx-a11y + enforce (the two passes). Catches *structural absence*. Owns the exit code; byte-identical whether or not recall runs. |
| **the recall layer** | the corpus → agent path (`review_a11y`). Catches *present-but-wrong* semantics the floor can't see. Advisory, quarantined — never gates the build. |
| **the slice** | the closed-vocabulary set of corpus patterns `retrieveSlice` hands the agent — the ONLY patterns it may nominate. Built four ways (R1–R4), tier-ordered, capped at `SLICE_CAP`. |
| **G0–G6** | the server-side gate stack in `review.ts` that disposes of the agent's nominations: anchor / closed-vocab / verbatim-quote-at-a-JSX-line / suppressor veto / abstention veto / confidence=high / tier floor. G7 (the agent's self-justification) and G8 (advisory framing) are NOT server gates. |
| **quarantine** | recall findings are `warn` / `layer: recall` / `provenance: corpus-agent`, deduped against the floor, and ride a SEPARATE `recall` field — never `scan().findings`, never the exit code. |
| **certified set / eligibleToFlag** | `CERTIFIED_RECALL_PATTERN_IDS` — the recall patterns proven precise through the Wilson gate (today 3). `eligibleToFlag` is the tier floor: only very-common/common patterns may flag; occasional-tier is context-only grounding. |
| **R4 / content-inspection** | the retriever that reads LOWERCASE intrinsic tags (`<img>`, raw `<a>`) the component-name retrievers (R1–R3) never see, via an EXPLICIT tag→pattern-id table (never token overlap) — "right pattern-set or empty, never wrong." |
| **the two producers** | where findings come from: the **source scan** (`.tsx` → resolve + two passes) and the **rendered-DOM** collector (`collect-dom.ts` → real browser + axe-core, for source-less / non-React pages). Both feed the same `enrichAll` + gate. |
| **provenance** | which producer a finding came from: `jsx-a11y` / `enforce` (source) or `axe` (rendered DOM). The `axe` findings anchor on a CSS `selector` instead of `file:line`. |
| **conservatism** | enforce fires only when a problem is *provably* there. Uncertain → skip. The rule that keeps false positives near zero. |
| **strength** | how confidently a control was recognized: `host` (proven) fires harder than `name` (a guess). |
| **corpus tier** | how common a failure is across the 26 audited orgs: very-common / common / occasional. |
| **the contract** | `binclusive.json` — the repo's committed a11y policy (escape hatch + block/warn + learned rules). |
| **determinism boundary** | LLM judgment runs offline and is frozen as data; everything shipped is deterministic code. |
| **the AGENTS block** | the generated section in `AGENTS.md`/`CLAUDE.md` that puts the corpus rules in front of the AI before it writes code. |

---

*Maintenance: this map is code-derivable. If the `src/` layout or the `scan()`
flow changes, update §2 and §3 — they're the parts that drift.*
