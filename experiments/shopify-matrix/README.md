# shopify-matrix

The **real-world regression gate for the Liquid checker** — the Shopify-theme
analog of `experiments/stack-matrix/` (which gates the React resolver over 31
SHA-pinned repos). A SHA-pinned corpus of real Shopify OS2 themes is scanned by
`scanLiquid` (the in-process L1+L2 Liquid path), distilled into a committed
`baseline.json`, and a fresh scan is diffed against it. The gate fails on any
drift, so a future change to the Liquid checker that moves its results on a real
theme is impossible to miss in review.

## Corpus (`manifest.json`)

SHA-pinned so the **only** thing that can move the numbers is this checker's own
code (L1 `liquid-ast.ts`, L2 `liquid-rules.ts`, `collect-liquid.ts`) — never
upstream theme drift.

| Theme | Ref | SHA | .liquid files |
|-------|-----|-----|---------------|
| `Shopify/dawn` | `v15.5.0` | `83d5e6b…02ffe2` | 95 |
| `Shopify/horizon` | `HEAD` | `7479288…2faf75` | 261 |

Both are official Shopify source-available OS2 reference themes. To extend the
corpus, add a public Shopify OS2 theme to `manifest.json`, resolve its sha
(`git ls-remote https://github.com/<owner>/<repo> HEAD`), and re-bless.

## Flow

```sh
pnpm shopify:matrix:run        # clone each pinned theme @ sha + scan → results/*.json
pnpm shopify:matrix:baseline   # distill results/ → baseline.json (committed, sorted)
pnpm shopify:matrix:check      # re-scan + diff current vs baseline; non-zero on drift
```

Or directly: `tsx experiments/shopify-matrix/{run,baseline,check}.ts`.

`pnpm shopify:matrix:check --no-run` re-diffs the existing `results/` against the
baseline without re-cloning — useful for re-reading a delta.

### Pinned vs regenerated

`manifest.json` and `baseline.json` are **committed** — they are the regression
record. `results/` and `.cache/` are **gitignored** — raw and reproducible from
the pinned manifest. Each result is stable by construction: findings are sorted
by `(file, line, ruleId)` and `byRule` keys are sorted, so a real change shows up
as a minimal, reviewable diff.

## The re-bless flow (mirror of the React baseline)

`shopify:matrix:check` exits non-zero when the Liquid checker's results move on
any pinned theme. **A delta is not automatically a bug** — read it:

- New/changed findings that are **real accessibility problems now caught**, or a
  parse-error count that legitimately dropped → intended. Re-bless:
  `pnpm shopify:matrix:baseline`, then commit the updated `baseline.json` **in
  the same PR** as your code change, so the shift is visible in review.
- New findings that are **false positives**, coverage that **dropped**, or a
  parse-error count that **rose** (more real theme files silently skipped) →
  regression. Fix the code before finishing.

Never run `shopify:matrix:baseline` to silence a delta you have not understood —
the committed `baseline.json` is the record that makes real-world Liquid drift
visible in review. Re-blessing blindly defeats the entire mechanism.

## Baseline snapshot (at corpus seed)

| Theme | Files scanned | Findings | Parse errors (skipped) |
|-------|---------------|----------|------------------------|
| `Shopify/dawn` | 95 | 4 (all `liquid/control-no-name`) | 0 (0.0%) |
| `Shopify/horizon` | 261 | 8 (all `liquid/control-no-name`) | 0 (0.0%) |

### Parse-error (under-scan) rate — measured signal

`parseLiquid` runs with `allowUnclosedDocumentNode: false`, so an
unclosed-document fragment is recorded as a parse error and **skipped** rather
than scanned. The hypothesis going in was that Shopify snippets — often HTML
fragments with no full document — would push this skip rate high enough that the
static checker under-scans real themes (an L1 strictness issue).

**Measured: 0 skipped / 356 files (0.0%) across Dawn + Horizon.**
`@shopify/liquid-html-parser` tolerates these themes' fragment snippets fine — on
these two official reference themes the strictness does not cause under-scanning.
The rate is recorded per-theme in `baseline.json` (`parseErrorCount` /
`parseErrorRate`) and is now itself a gated quantity: if a future checker change
(or a newly added theme) pushes files into the skipped set, the gate flags it as
a `parseErrors` delta. Because the measured rate is well below the 15% concern
threshold, no L1-strictness follow-up was filed for this corpus.
