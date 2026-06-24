# unity-matrix

The **real-world regression gate for the Unity a11y checker** (#66/#69) — the
Unity analog of `experiments/shopify-matrix/` (Liquid) and
`experiments/stack-matrix/` (React). A SHA-pinned corpus of real Unity games is
scanned by `scanUnity` (the in-process Unity producer: L1 `unity-ast.ts` + L3
`collect-unity.ts` + `unity-guid-registry.ts`), distilled into a committed
`baseline.json`, and a fresh scan is diffed against it. The gate fails on any
drift, so a future change to the Unity checker that moves its results on a real
game is impossible to miss in review.

## What is gated (and why it is parse-outcome, not findings)

The Unity producer **emits no findings yet** — the structural-absence rules are
later children (#70/#72/#73). So the quantity this corpus gates is the per-asset
**parse outcome**:

- `assetsScanned` — `.prefab` + `.unity` YAML assets walked.
- `graphCount` — assets that parsed to a walkable node graph.
- `opaqueBinary` — assets reported **opaque** because they are binary
  (non-Force-Text). This is the Force-Text precision seam (ADR 0004): a binary
  asset is **reported opaque, not silently skipped**, and the count is committed
  so a regression that starts silently dropping real UI assets is a visible diff.
- `opaqueParseError` — assets that are Force-Text but unparseable (also opaque).

`graphCount + opaqueBinary + opaqueParseError == assetsScanned` by construction —
every asset lands in exactly one bucket, so a vanished asset surfaces as a sum
mismatch. When the rule children land and `scanUnity` grows a findings surface,
extend the result/baseline shape the same way `shopify-matrix` carries `byRule` +
`findings`.

## Corpus (`manifest.json`)

SHA-pinned so the **only** thing that can move the numbers is this checker's own
code — never upstream repo drift.

| Repo | UI system | SHA | Notes |
|------|-----------|-----|-------|
| `UnityTechnologies/open-project-1` | uGUI | `608eac9…7345b1` | "Chop Chop", Unity-official open game; heavy real menu/HUD/inventory/dialogue UI, text-serialized. |

To extend the corpus, add a public Unity game repo with real in-game UI to
`manifest.json`, resolve its sha (`git ls-remote https://github.com/<owner>/<repo> HEAD`),
and re-bless.

### Pinning caveat — open-project-1 is a uGUI anchor, NOT a runtime-UI-Toolkit anchor

open-project-1's 4 `.uxml` files
(`Quests/Editor/StepDetail.uxml`, `Quests/Editor/DialogueLine.uxml`,
`Quests/Resources/QuestEditorWindow.uxml`,
`StateMachine/Editor/TransitionTableEditorWindow.uxml`) are **all Editor
tooling**, not runtime game UI. Its in-game UI (MainMenu, Pause, Inventory,
Dialogue, HUD) is **100% uGUI prefabs** under `UOP1_Project/Assets/Prefabs/UI/`.
So this repo is an excellent **uGUI** anchor (Unity-authored ground truth,
text-serialized, heavy real UI) but does **not** exercise the runtime `.uxml` /
`UIDocument` checker code path at all. A separate corpus repo using **UI Toolkit
for runtime UI** is still needed to cover that path. (Correction logged on #69.)

The pinned sha `608eac98…` is the `main`-branch HEAD at corpus seed
(`608eac98 == refs/heads/main`), so a `--branch main --depth 1` clone parks
exactly on it and `pinned` stays true — even though GitHub refuses a direct
fetch-by-sha of that (unadvertised-as-a-blob) commit.

## Flow

```sh
pnpm unity:matrix:run        # clone each pinned repo @ sha + scan → results/*.json
pnpm unity:matrix:baseline   # distill results/ → baseline.json (committed, sorted)
pnpm unity:matrix:check      # re-scan + diff current vs baseline; non-zero on drift
```

Or directly: `tsx experiments/unity-matrix/{run,baseline,check}.ts`.

`pnpm unity:matrix:check --no-run` re-diffs the existing `results/` against the
baseline without re-cloning — useful for re-reading a delta.

### Pinned vs regenerated

`manifest.json` and `baseline.json` are **committed** — they are the regression
record. `results/` and `.cache/` are **gitignored** — raw and reproducible from
the pinned manifest. Each result is stable by construction: `opaqueAssets` is
sorted by `(file, reason)`, so a real change shows up as a minimal, reviewable
diff.

## The re-bless flow (mirror of the React/Liquid baselines)

`unity:matrix:check` exits non-zero when the Unity producer's results move on any
pinned repo. **A delta is not automatically a bug** — read it:

- An asset that newly **parses to a graph** (or an opaque count that legitimately
  dropped) → intended. Re-bless: `pnpm unity:matrix:baseline`, then commit the
  updated `baseline.json` **in the same PR** as your code change, so the shift is
  visible in review.
- An asset that **newly goes opaque** (a real UI prefab the producer can no
  longer parse), or `assetsScanned` that **dropped** (files silently no longer
  walked) → regression. Fix the code before finishing.

Never run `unity:matrix:baseline` to silence a delta you have not understood —
the committed `baseline.json` is the record that makes real-world Unity drift
visible in review. Re-blessing blindly defeats the entire mechanism.

## Baseline snapshot (at corpus seed)

| Repo | Assets | Graph | Opaque (binary / parse) |
|------|--------|-------|-------------------------|
| `UnityTechnologies/open-project-1` | 533 | 533 | 0 (0 / 0) |

**Measured: 0 opaque / 533 assets (0.0%).** Every `.prefab` + `.unity` asset in
open-project-1 is Force-Text (`%YAML 1.1`) and parses cleanly — confirming it as
a clean, fully-walkable uGUI anchor. This empirically answers two of the #66
precision questions on real code: **Force Text is present** (no binary assets to
report opaque on this repo), and the producer reaches a node graph on 100% of the
in-game-UI asset surface. The opaque rate is now a gated quantity: if a future
producer change pushes a real asset into the opaque set, the gate flags it as an
`opaque(binary)` / `opaque(parse)` delta.
