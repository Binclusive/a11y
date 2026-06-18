# R4 — Content-Inspection Retriever

Status: IMPLEMENTED — design + code in this PR.
Author: design pass, 2026-06-18.
Scope: `src/retrieve.ts` (the R4 table + clause) plus the pure element-extraction helper `src/intrinsic-elements.ts`; consumed by `src/review.ts` and `src/hook.ts`.

---

## 1. Problem (grounded)

`retrieveSlice` (`src/retrieve.ts:96`) builds the grounding slice from three retrievers:

- **R1** — token-overlap of a *resolved component name/host* against a pattern's `component` label (`src/retrieve.ts:131-136`).
- **R2** — the SC of an existing static finding (`src/retrieve.ts:139-140`).
- **R3** — journey path hints (`src/retrieve.ts:143`).

All three only see **imported, capitalized** JSX. R1 reads `input.resolutions`, which come from `collectUsedComponents` (`src/resolve-components.ts:177`) — and that walker hard-filters on `CAP_NAME = /^[A-Z]/` (`src/resolve-components.ts:52,187`). A capitalized name with no import binding is dropped too (`:189-190`). So **intrinsic lowercase elements never produce a resolution, never reach R1, and the slice for a file that is all-intrinsic is empty.**

Consequence, already proven in the corpus-recall work: a hand-rolled `<img alt="IMG_4821.jpg">` or `<a href>click here</a>` comes back **floor-clean** (jsx-a11y's `anchor-has-content` / `alt-text` are satisfied — the alt and the link text are *present*) **and** with an **empty slice** → G0 fires (`src/retrieve.ts:160`, `src/review.ts` gate G0) → the recall layer is structurally incapable of flagging it. This is where most real-world content failures live (the corpus has 647 findings under 1.1.1 alone, `data/corpus/patterns-1.1.1.json` `_meta.corpusFindings`).

## 2. Goal

Add **R4 — content/element inspection**: ground the corpus patterns the *actual intrinsic elements and their content* in the file can exhibit, WITHOUT reopening the cross-kind precision leak the F6 stopwords (`icon`/`image`/`empty`, `src/retrieve.ts`) closed. R4 is **explicit element-kind → pattern-id mapping**, not token overlap.

---

## 3. Element extraction (what we pull, which walker)

### 3.1 Reuse, don't reinvent

The repo already has the exact walk shapes R4 needs:

| Need | Existing machinery | Location |
|---|---|---|
| Visit every JSX element, intrinsic or not | `ts.forEachChild` recursive `visit` | `src/resolve-components.ts:200-211`, also `src/source-trace.ts:497-503` |
| Distinguish intrinsic vs component | `CAP_NAME` test (lowercase tag = intrinsic host) | `src/resolve-components.ts:52,187` |
| Read whether an element renders static visible text / sr-only name | `isStaticTextChild`, `rendersStaticNameInChildren` | `src/source-trace.ts:338-360` |
| Read an attribute's present/dynamic/missing state | `attrState` / `anyNameAttr` (suppressor predicates) | `src/suppressors.ts` |
| 1-based opening-tag line for anchoring | `walkAncestorSuppressors` visitor `line` | `src/suppressors.ts:`AncestorVisitor |

**Decision:** R4 adds a single new pure function `collectIntrinsicElements(sf: ts.SourceFile): IntrinsicElement[]` (co-located with the retriever or in a small `src/intrinsic-elements.ts`). It is a **copy of the resolve-components `visit` shape**, but instead of filtering to `CAP_NAME` imports it keeps the **lowercased** tag names and reads a small content signal per element using the *already-exported* helpers above. It does NOT duplicate any text-reading logic — it calls `isStaticTextChild` et al.

> Note: `retrieveSlice` today takes `RetrieveInput { files, resolutions, findings }` (`src/retrieve.ts`) but does NOT currently re-parse the source — it works off the already-computed `resolutions`. R4 needs the AST. Two clean options; **recommended (A)**: `reviewA11y` / `recallWhisper` already parse the file (`scan` runs the floor, `src/review.ts`), so pass the extracted `IntrinsicElement[]` into `RetrieveInput` as a new field `intrinsics` — keeping `retrieveSlice` **pure and AST-free** (the property it's prized for). The caller does the one walk. (B) re-parse inside retrieve — rejected: breaks purity, double-parses on the hot hook path.

### 3.2 The extracted shape (the content signal)

```
interface IntrinsicElement {
  readonly tag: string;        // lowercased intrinsic tag: "img" | "a" | "button" | ...
  readonly line: number;       // 1-based opening-tag line (for nothing today; future anchoring)
  readonly signals: {
    readonly altState: AttrState;       // img: missing | present | dynamic   (reuse attrState)
    readonly hrefState: AttrState;      // a:   missing | present | dynamic
    readonly hasVisibleText: boolean;   // a/button: rendersStaticNameInChildren
    readonly nameAttrState: AttrState;  // aria-label/labelledby present?      (reuse anyNameAttr)
  };
}
```

We extract only the **kind + the coarse content state** — never the literal alt string, never the link text. R4's job is *retrieval* (ground the right patterns); the model in the propose step reads the real bytes and the G0-G6 gates dispose. Keeping R4 content-coarse means it cannot itself become a second, divergent content checker.

---

## 4. The mapping: intrinsic element → corpus pattern-ids (explicit table, NOT tokens)

### 4.1 Why explicit, not token overlap

Token overlap is what *created* the F6 leak. The pattern `2.4.4-link-no-name` has the literal `component` label **"icon / image / empty link"** (`data/corpus/patterns-2.4.4.json`). A bare `image` token from an `<img>` (or from `IconButton`) overlaps that LINK pattern — admitting a link rule into a non-link slice as `eligibleToFlag`. F6 closed this by *stopwording* `image`/`icon`/`empty` so they carry no overlap signal. That fix is load-bearing and R4 must not undo it.

So for intrinsic elements we do the opposite of token overlap: a **small curated `Map<tag, patternId[]>`**. An `<img>` grounds image patterns *because the table says so*, never because a word matched. The table is the closed vocabulary; it is auditable in one screen; it can never map a tag to a pattern that tag can't exhibit.

### 4.2 The table (full proposed set; ship a subset — see §8)

Only **content-quality / non-floor** shapes belong in R4 — the floor already owns the hard-missing cases (no-alt, no-name). Mapping is by what the *element kind can genuinely exhibit*:

```
const R4_ELEMENT_PATTERNS: Record<string, readonly string[]> = {
  img: [
    "1.1.1-filename-or-generic-alt",     // common  — alt present but a filename/id/placeholder
    "1.1.1-alt-too-long-or-redundant",   // occasional (context-only, won't flag)
    "1.1.1-alt-wrong-or-insufficient",   // occasional (context-only)
  ],
  a: [
    "2.4.4-generic-link-text",           // common  — text present but non-descriptive
    "2.4.4-noisy-or-wrong-name",         // common  — name polluted (url/sku/filename)
    "3.2.5-new-window-not-signaled",     // occasional (context-only)
  ],
  button: [
    // content-quality button shapes are mostly floor-owned (no-name) or trusted-
    // component state (selected/expanded). No common, intrinsic, floor-missed,
    // certifiable button content pattern today → button maps to [] in first cut.
  ],
};
```

Gating to `eligibleToFlag` (very-common/common) still happens in the existing `.map(... FLAGGABLE_TIERS.has(p.tier))` line (`src/retrieve.ts:166`), so the `occasional` entries above are retrieved for *context only* and can never surface a finding — same as R1/R2/R3 patterns. They are listed so the slice the agent reads is complete.

### 4.3 Wiring into `retrieveSlice`

One added clause in the matched-pattern loop (`src/retrieve.ts:153-159`), parallel to r1/r2/r3:

```
const r4Ids = new Set<string>();
for (const el of input.intrinsics) for (const id of R4_ELEMENT_PATTERNS[el.tag] ?? []) r4Ids.add(id);
...
const r4 = r4Ids.has(p.id);
if (r1 || r2 || r3 || r4) matched.set(p.id, p);
```

R4 unions in exactly like the others; dedup-by-id, SLICE_CAP, tier-eligibility, and ordering are all unchanged.

### 4.4 (Refinement) gate R4 on the content signal, not just tag presence

Stronger precision: only union a pattern when the element's signal is consistent with that pattern's *premise*. e.g. `1.1.1-filename-or-generic-alt` is about an alt that is **present but bad** → only union it when `altState === "present"` (a missing-alt `<img>` is a *floor* case, §6). Likewise `2.4.4-generic-link-text` only when `hasVisibleText` is true. This is a per-pattern predicate keyed in the same table (`{ id, when: (s) => s.altState === "present" }`). It is optional for v1 (the SC-disjoint floor filter already removes the missing-alt overlap, §6) but it tightens the slice and is cheap. **Recommend including it** — it is the same FN-safe "uncertain → still retrieve" discipline as the suppressors.

---

## 5. Precision / leak safety

### 5.1 The exact F6 scenario

`IconButton` → tokenize → `{icon, button}`. Pattern `2.4.4-link-no-name` component = "icon / image / empty link" → tokenize → `{link, ...}` once `icon`/`image`/`empty` are stopworded, but **before** F6 the shared `icon`/`image` produced overlap → the LINK pattern entered a BUTTON-only slice as `eligibleToFlag` → false positive at a button call site → the uninstall failure mode (the precision invariant, `CLAUDE.md`).

### 5.2 Why R4 cannot reintroduce it

1. **R4 never tokenizes.** It is a `Map<tag, id[]>` lookup. There is no string match between an element and a pattern, so there is no shared-word path. `<img>` resolves to *exactly* the ids under key `img` — `2.4.4-link-no-name` is **not** in that list and cannot appear by accident.
2. **The table is keyed by the host the element literally is.** An `<img>` is an image; it maps only to image patterns. A pattern the element can't exhibit is unreachable because *no human put it in that element's row*. This is the same precision guarantee the resolver's "correct host or stay opaque" invariant gives — R4 is the intrinsic-element analogue: **right pattern-set or empty**, never wrong-pattern.
3. **F6 stopwords stay exactly as they are.** R4 adds a path; it removes nothing. R1's `tokenize`/STOPWORDS behavior is byte-identical. The matrix gate (`pnpm matrix:check`) confirms R1 didn't move.
4. **`eligibleToFlag` + `CERTIFIED_RECALL_PATTERN_IDS` are downstream of R4.** Even if the table were wrong, an un-certified id still cannot reach the hook advisory (`src/hook.ts:` the `CERTIFIED_RECALL_PATTERN_IDS.has(p.id)` filter) and an `occasional` id cannot flag (G6, `src/review.ts`). R4 widens *retrieval*; it does not widen *what may flag*.

**What stops R4 grounding a pattern the element can't exhibit:** the table is the whitelist. Adding a wrong row is a code change caught in review + the cert (§7). There is no inference layer to go wrong.

---

## 6. Floor-disjointness (the critical interaction)

Two `<img>` cases, must not collide:

| Case | Floor behavior | R4 behavior | Net |
|---|---|---|---|
| `<img>` **no alt** | jsx-a11y `alt-text` / `jsx-a11y/alt-text` **fires** → floor finding, SC 1.1.1 | R4 grounds `1.1.1-*` into slice | hook's **SC-disjoint filter drops them** |
| `<img alt="IMG_4821.jpg">` | alt present → floor **silent** | R4 grounds `1.1.1-filename-or-generic-alt` | recall surfaces it — the win |

The disjointness is already enforced and **needs no new code**:

- `recallWhisper` (`src/hook.ts`) computes `floorScs = new Set(result.findings.flatMap(f => f.wcag))` and filters `!floorScs.has(p.sc)`. So when the floor already fired 1.1.1 (no-alt case), **every** R4-grounded 1.1.1 pattern is dropped from the advisory. No double-up.
- The verify path has the same protection structurally: `dedupeRecall` (`src/core.ts:390`) drops any recall finding whose `(file,line,sc)` a static finding already covers (`src/core.ts:367-369`).
- The §4.4 `altState === "present"` predicate makes it even cleaner: R4 doesn't even *retrieve* `1.1.1-filename-or-generic-alt` for a missing-alt `<img>`, because the premise (alt present) is false.

So R4 only ever *adds* the content-quality recall patterns on a **floor-clean** element. Floor and recall stay disjoint by SC, exactly as the existing `<Link>` recall does.

---

## 7. What becomes certifiable once R4 exists

Today only the two **link-text** patterns are certified (`CERTIFIED_RECALL_PATTERN_IDS = {2.4.4-generic-link-text, 2.4.4-noisy-or-wrong-name}`, `src/retrieve.ts`), and they're reachable today only via *imported* `<Link>` wrappers (R1). R4 makes the **intrinsic** variants reachable and unlocks new image patterns:

| patternId | tier | why newly reachable | one-line fixture sketch |
|---|---|---|---|
| `1.1.1-filename-or-generic-alt` | common | THE headline win — floor-missed (alt present), un-retrievable before (no import) | `<img src="/p.jpg" alt="IMG_4821.jpg" />` — expect 1.1.1 |
| `2.4.4-generic-link-text` (intrinsic `<a>`) | common | already certified via `<Link>`; R4 makes raw `<a>` reach it | `<a href="/x">click here</a>` — expect 2.4.4 |
| `2.4.4-noisy-or-wrong-name` (intrinsic `<a>`) | common | same, raw anchor | `<a href="/x">https://site/p?id=4821</a>` — expect 2.4.4 |

Note the corpus also has `2.4.4-social-icon-link-no-name` (common) and `4.1.2-*` button shapes, but those are **floor-owned or trusted-component-state** (e.g. `4.1.2-selected-or-current-state-missing` only false-positives on self-managing trusted tab components — the corpus-recall README already reclassified antd `<Tabs>` to a hard negative). They are **not** R4 candidates. R4's certifiable surface in the first wave is exactly the three rows above; `1.1.1-filename-or-generic-alt` is the one genuinely-new pattern.

---

## 8. Certification plan

The harness is fully reusable as-is; R4 is just more fixtures + allowlist entries.

Mechanism recap (verified in code):
- `experiments/corpus-recall/case-set.ts` — `positive(name, expect[])` / `negative(name)` over fixtures in `cases/positive|negative/`. Each positive pins `{patternId, line, wcag}` (`case-set.ts:72-96`).
- `experiments/corpus-recall/eval.ts` — runs every case through the **real** `reviewA11y` verify stack, computes precision (Wilson lower bound, gate ≥ 0.95) and recall (`eval.ts:92-108`).
- `experiments/corpus-recall/blind-harness.ts` + committed `certification/noms-pass-{1,2,3}.json` — the **blind 3-pass** nominations, re-scored deterministically in `test/recall-certification.test.ts` (no model at test time).
- `test/recall-certification.test.ts:52-61` — **the lockstep assertion**: the set of positive-fixture patternIds MUST `toEqual` `CERTIFIED_RECALL_PATTERN_IDS`. Adding a certified pattern WITHOUT a fixture (or vice-versa) fails the build. It also asserts `pooledTotal >= 70`, zero decoy leaks, pooled Wilson ≥ 0.95, zero drops on positives (`:81-90`).

Steps to certify R4 patterns:
1. Add `1.1.1-filename-or-generic-alt` to `CERTIFIED_RECALL_PATTERN_IDS` (`src/retrieve.ts`). (The two 2.4.4 ids are already there.)
2. Add **intrinsic** positive fixtures: raw-`<img>` filename/generic-alt variants (e.g. `img-filename-alt.tsx`, `img-generic-icon-alt.tsx`, `img-slider-image-N-alt.tsx`, `img-pim-id-alt.tsx`), plus raw-`<a>` generic/noisy variants to certify R4's intrinsic path for the already-certified link patterns. Register each in `case-set.ts` via `positive(...)`.
3. Add **negative** fixtures that exercise R4's leak surfaces so precision is *measured* on them, not assumed:
   - `<img alt="A bar chart showing Q3 revenue up 12%">` — good alt, must NOT flag.
   - `<img alt="" />` (decorative) — must NOT flag (R4 must not treat empty-alt as a finding; that's the decorative path).
   - `<img>` with no alt — floor-caught; assert R4 does **not** double-flag (SC-disjoint).
   - `<button>...icon...</button>` and `<IconButton/>` near an `<img>`/`<a>` in the same file — proves R4's `img`/`a` rows don't bleed into button/icon context (the F6 scenario, now re-proven for R4).
4. Re-run the blind 3-pass to regenerate `certification/noms-pass-*.json` + `key.json` (the README documents the procedure), commit them.
5. `pnpm test` re-scores; the lockstep assertion + Wilson gate must stay green. `pnpm matrix:check` confirms the static floor and R1 are byte-unchanged on the 31-repo corpus (R4 only touches the recall slice, never the floor — but run it because `retrieve.ts` changed).

---

## 9. Scope / risk — recommended smallest first cut

**Ship `<img>` alt-quality only (`1.1.1-filename-or-generic-alt`) as cut 1.**

- It is the single genuinely-new certifiable pattern, the headline real-world gap (filename/generic alt is the most common 1.1.1 content failure in the corpus), and **independently certifiable**: it needs only the `img` table row, the `altState==="present"` predicate, ~5 positive + ~4 negative fixtures, and one allowlist entry.
- It touches the smallest surface: one new extractor function, one table with one populated key, one clause in `retrieveSlice`, one `CERTIFIED_RECALL_PATTERN_IDS` entry. The hook's SC-disjoint filter and `dedupeRecall` already handle the floor interaction with zero new code.
- Risk is contained: if cut 1 mis-certifies, only `img`/1.1.1 is affected; R1/R2/R3 and the floor are untouched and matrix-gated.

**Cut 2 (follow-up):** add the `a` row to extend the *already-certified* 2.4.4 link patterns to **intrinsic** `<a>` (raw anchors, not just imported `<Link>`). Lower novelty (patterns already certified) but real coverage gain. Add `button: []` stays empty until a common, intrinsic, floor-missed, certifiable button-content pattern exists.

**Explicitly out of scope:** any `occasional` pattern flagging (stays context-only via G6), any literal-content reading inside R4 (the model+gates own that), and button/icon/social-link content shapes (floor-owned or trusted-state false-positive risk).

---

## 10. Files this design touches (for the eventual PR)

- `src/intrinsic-elements.ts` (new) — `collectIntrinsicElements`, reusing `isStaticTextChild`/`attrState`/`anyNameAttr`.
- `src/retrieve.ts` — `R4_ELEMENT_PATTERNS` table, `intrinsics` field on `RetrieveInput`, the r4 clause, one `CERTIFIED_RECALL_PATTERN_IDS` add.
- `src/review.ts` + `src/hook.ts` — pass the extracted `intrinsics` into `retrieveSlice` (callers already hold the parsed source). No gate logic change.
- `experiments/corpus-recall/cases/{positive,negative}/*` + `case-set.ts` + `certification/*` — new fixtures + re-blessed blind passes.
- No change to: the static floor, jsx-a11y rules, the suppressor predicates, F6 stopwords, the gate stack G0-G6.
