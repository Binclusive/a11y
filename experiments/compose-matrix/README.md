# compose-matrix

The **real-world regression gate for the Jetpack Compose a11y checker** (#118, ADR
0008) — the Compose analog of `experiments/unity-matrix/` and the sibling of
`experiments/android-matrix/` (which gates the separate **Android XML-layout**
surface, #109/#122). A SHA-pinned corpus of real Compose apps is scanned by the
**out-of-process** Kotlin PSI engine (`kotlin/A11yKotlinScan/`) via its TS boundary
`scanKotlin` (`src/collect-kotlin.ts`), distilled into a committed `baseline.json`,
and a fresh scan is diffed against it. The gate fails on any drift, so a future
change to the Compose checker that moves its results on a real app is impossible to
miss in review.

> **Not to be confused with `android-matrix`.** `android-matrix` locks the in-process
> **XML-layout** engine (`src/collect-android-xml.ts`, rules `android-xml/*`); this
> gate locks the **Compose** engine (`compose/image-no-label`). Two distinct engines,
> two distinct corpora — NewPipe/AntennaPod (the android-matrix repos) are legacy-View
> XML apps and are the **wrong** surface for Compose.

## What is gated

The gated quantity is the **finding stream** — exactly like `unity-matrix`'s primary
layer. The Compose engine emits findings only (no per-asset parse-outcome layer), so
findings are the whole snapshot:

- `findingsCount` — total findings the engine emitted over the repo.
- `byRule` — `ruleId → count`, so a diff reads `compose/image-no-label +3`, not just
  `findings +3`.
- `findings` — the full list, sorted by `(file, line, ruleId)`, so a moved / added /
  removed finding is a line-level, reviewable diff — not just an aggregate count.

The one real difference from `unity-matrix` is the scanner boundary: unity scans
**in-process**, whereas Compose runs the Kotlin engine **out-of-process** (JDK/Gradle).
The engine must be **built once** before scanning (see [Building the engine](#building-the-engine-required-once)).

## Corpus (`manifest.json`)

SHA-pinned so the **only** thing that can move the numbers is this checker's own
code — never upstream repo drift.

| Repo | SHA | Findings | Role |
|------|-----|----------|------|
| `Automattic/pocket-casts-android` | `0466b77…994b4f` | 6 (`compose/image-no-label`) | non-trivial anchor — a real production app whose real omissions the rule catches |
| `android/nowinandroid` | `7d45eae…74b6ed` | 0 | clean anchor — Google's reference Compose app, correctly labeled; locks the no-false-positive precision invariant |
| `chrisbanes/tivi` | `a0c62c2…b06c4a` | 0 | clean anchor — a second independent all-Compose codebase |

The corpus deliberately mixes a **real-catch** repo with two **0-finding** anchors: the
gate locks both that the rule *fires* on real unlabeled Compose UI **and** that it does
**not** mis-flag well-labeled, Google-authored code — the precision invariant a false
positive on a labeled control would violate (ADR 0008).

To extend the corpus, add a public Compose repo with real `.kt` UI to `manifest.json`,
resolve its sha (`git ls-remote https://github.com/<owner>/<repo> HEAD`), and re-bless.

## Building the engine (required once)

The Compose engine is a Gradle project run as a subprocess; build its `installDist`
launcher before the first scan (the JDK path shown is the Homebrew default):

```sh
cd kotlin/A11yKotlinScan
export JAVA_HOME=/opt/homebrew/opt/openjdk
export PATH="$JAVA_HOME/bin:$PATH"
./gradlew installDist -q
```

`scanKotlin` resolves that launcher automatically; if it hasn't been built it falls
back to `./gradlew run` (slower, compiles on first use). Either way the JVM is resolved
via `JAVA_HOME`/`PATH`.

## Flow

```sh
pnpm compose:matrix:run        # clone each pinned repo @ sha + scan → results/*.json
pnpm compose:matrix:baseline   # distill results/ → baseline.json (committed, sorted)
pnpm compose:matrix:check      # re-scan + diff current vs baseline; non-zero on drift
```

Or directly: `tsx experiments/compose-matrix/{run,baseline,check}.ts`.

`pnpm compose:matrix:check --no-run` re-diffs the existing `results/` against the
baseline without re-cloning — useful for re-reading a delta.

### CI

The JDK/Gradle Kotlin CI job is owned by **#115**; this gate does **not** add a
workflow. CI invokes it via the `compose:matrix:check` script once the engine is built.

### Pinned vs regenerated

`manifest.json` and `baseline.json` are **committed** — they are the regression record.
`results/` and `.cache/` are **gitignored** — raw and reproducible from the pinned
manifest. Each result is stable by construction: `findings` is sorted by
`(file, line, ruleId)`, so a real change shows up as a minimal, reviewable diff.

## The re-bless flow (mirror of the unity/React/Liquid baselines)

`compose:matrix:check` exits non-zero when the Compose checker's results move on any
pinned repo. **A delta is not automatically a bug** — read it:

- A finding the engine **now correctly catches** (a real unlabeled Compose image) →
  intended. Re-bless: `pnpm compose:matrix:baseline`, then commit the updated
  `baseline.json` **in the same PR** as your code change, so the shift is visible in
  review.
- A finding that's a **false positive**, or findings that **dropped** (lost coverage) →
  regression. Fix the code before finishing.

Never run `compose:matrix:baseline` to silence a delta you have not understood — the
committed `baseline.json` is the record that makes real-world Compose drift visible in
review. Re-blessing blindly defeats the entire mechanism.

## Baseline snapshot (at corpus seed)

| Repo | Findings | By rule |
|------|----------|---------|
| `Automattic/pocket-casts-android` | 6 | `compose/image-no-label` 6 |
| `android/nowinandroid` | 0 | — |
| `chrisbanes/tivi` | 0 | — |

The 6 pocket-casts findings are `Image`/`Icon` call sites with no `contentDescription`
across the `profile`, `referrals`, and `reimagine` feature modules — all `serious`. If
a future engine change moves a per-rule count on any repo (a new catch, a lost catch,
or a regression into a false positive on the clean anchors), the gate flags it as a
delta.
