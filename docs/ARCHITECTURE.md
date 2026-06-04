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
"trusted" library components. Every finding is then matched against the audit
corpus, so it tells you not just *that* something's wrong but *how common* that
failure is in the real world and the fix that worked. It runs locally, plugs into
AI coding tools, and never sends your code anywhere.

**The one-line "how."** *Resolve what each component is → look for problems two
ways → match each finding to the corpus.* Everything else is detail under those
three moves.

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
dedupe) → enrich → report** — you've explained the machinery.

---

## 3. The five jobs, and the code that does each

The whole `src/` tree groups into five jobs plus delivery. ~10k lines total.

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

### Job 2 · DETECT — "which elements are broken?"
| File | What it does |
|---|---|
| `core.ts` | **The conductor — `scan()`.** Runs resolve, then pass one (jsx-a11y), then pass two (enforce), dedupes, returns findings + coverage. Start here to read the system. |
| `enforce.ts` | **Pass two.** The corpus-driven call-site content check + every conservatism guard. The biggest single file — this is the recall win and the false-positive discipline. |
| `trans-suppress.ts` | Computes the line ranges where a content finding is a false positive (runtime-injected children like `<Trans>`, or `aria-hidden`), so neither pass fires there. |
| `wcag-map.ts` | Maps each jsx-a11y rule id → its WCAG SC. The bridge that lets a finding be matched to the corpus. |

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
| `cli.ts` | The `a11y-checker` command: `check`, `init`, `learn`, `gen`, `mcp`, `hook` + the report formatting. |
| `mcp.ts` | A local stdio MCP server exposing `check_a11y` / `get_a11y_rules` / `learn_a11y_rule` to Cursor/Copilot/Claude. |
| `hook.ts` | The Claude Code `PostToolUse` auto-whisper hook: scans the just-edited file and feeds findings back into the same turn. |
| `index.ts` | The public API barrel — re-exports everything for programmatic use. |
| `collect.ts` | Recursively finds the `.tsx` files to scan (skips generated dirs). |

---

## 4. How it's organized

**The layering — pure core, thin IO shell.** The logic that decides things
(resolve, enforce, distill, parse, render) is pure and unit-tested. The files
that touch disk or the network (`cli.ts`, `commands.ts`, `mcp.ts`, `hook.ts`,
`run-distill.ts`) are thin shells around that pure core. Tests exercise the core;
the shells just wire it up.

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
│   ├── enforce.ts             pass two + the FP guards      ← job 2 (the recall win)
│   ├── trans-suppress.ts      false-positive line ranges    ← job 2
│   ├── wcag-map.ts            rule id → WCAG SC             ← job 2 (bridge)
│   ├── corpus.ts              match findings to the corpus  ← job 3
│   ├── contract.ts / config-scan.ts / commands.ts / detect-stack.ts / agents-block.ts   ← job 4
│   ├── distill/               the offline corpus factory    ← job 5
│   ├── mcp.ts / hook.ts       AI delivery surfaces          ← delivery
│   └── index.ts               public API barrel
├── data/
│   ├── corpus-snapshot.json   seed SC-level frequencies (643 findings / 26 orgs)
│   ├── clusters/clusters-<SC>.json   frozen LLM failure-shape groupings (input)
│   └── corpus/
│       ├── patterns-<SC>.json shipped distilled patterns (what the checker reads)
│       └── ledger-<SC>.json   no-silent-drops drop counts
├── plugin/                    the Claude Code plugin (MCP + hook bundled)
├── test/                      unit tests + fixtures (the pure core)
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
| **conservatism** | enforce fires only when a problem is *provably* there. Uncertain → skip. The rule that keeps false positives near zero. |
| **strength** | how confidently a control was recognized: `host` (proven) fires harder than `name` (a guess). |
| **corpus tier** | how common a failure is across the 26 audited orgs: very-common / common / occasional. |
| **the contract** | `binclusive.json` — the repo's committed a11y policy (escape hatch + block/warn + learned rules). |
| **determinism boundary** | LLM judgment runs offline and is frozen as data; everything shipped is deterministic code. |
| **the AGENTS block** | the generated section in `AGENTS.md`/`CLAUDE.md` that puts the corpus rules in front of the AI before it writes code. |

---

*Maintenance: this map is code-derivable. If the `src/` layout or the `scan()`
flow changes, update §2 and §3 — they're the parts that drift.*
