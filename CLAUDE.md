# a11y-checker — agent guide

A local accessibility checker for React/TSX, grounded in a real audit corpus.
It resolves what HTML element each component really is, checks for problems two
ways (jsx-a11y lint + a corpus-driven content pass), and matches each finding to
real-world failure frequency. Runs locally, no network for the static path.

Map of the system: `docs/ARCHITECTURE.md`. Adversarial Q&A: `docs/GRILL-ME.md`.

## Before you finish ANY change

Run both — they are fast (~10s) and catch most regressions:

```
pnpm typecheck     # tsc --noEmit
pnpm test          # vitest run — the unit + property suite
```

Do not declare a task done with either red.

## If you touched the Swift collector — run its tests

The Swift collector (`swift/A11ySwiftScan/`, the 4th / SwiftUI-static path) has the
same precision invariant as the JS resolver: map to the correct host or stay
opaque, never the wrong host. Its guard is a SwiftPM test target — run it from the
package before finishing any Swift change:

```
cd swift/A11ySwiftScan && swift test     # builds A11ySwiftScanCore + runs the fixture suite
```

The engine lives in the testable `A11ySwiftScanCore` library (the executable is a
thin shell over it); tests drive the climb against fixture `.swift` files under
`Tests/A11ySwiftScanCoreTests/Fixtures/` with known expected findings — a positive
(missing label → finding) and a negative (labeled control → no false positive). Add
a fixture + assertion alongside any rule change, mirroring `test/fixtures/`. CI runs
`swift test` on every push/PR touching the package (`.github/workflows/swift.yml`).

## If you touched the Kotlin/Compose collector — run its tests

The Compose collector (`kotlin/A11yKotlinScan/`, the Android/Jetpack-Compose-static
path; ADR 0008) holds the same precision invariant as the JS resolver: map to the
correct host or stay opaque, never the wrong host. Its guard is a Gradle/JUnit test
target — run it from the package before finishing any Kotlin change (needs a JDK; on
this machine `JAVA_HOME=/opt/homebrew/opt/openjdk`):

```
cd kotlin/A11yKotlinScan && ./gradlew test    # builds the PSI engine + runs the fixture suite
```

The committed Gradle wrapper pins the toolchain, so the command is reproducible. Tests
(`src/test/kotlin/.../ScanTest.kt`) drive the PSI scan against fixture `.kt` files under
`src/test/resources/fixtures/` with known expected findings — a positive
(`MissingContentDescription.kt`: a `contentDescription`-less `Image`/`Icon` → one
`compose/image-no-label` finding) and a negative (`LabeledImage.kt`: a labelled or
decorative control → no false positive). The fixtures live under `resources/` so they
are *parsed as source text*, never compiled into the test module (the Swift
`exclude: ["Fixtures"]` analogue). Add a fixture + assertion alongside any rule change,
mirroring `test/fixtures/`. Dir-level scans assert against the dedicated
`fixtures/aggregate/` subtree, never the shared `fixtures/` dir (the #84 cross-PR
collision class). CI runs `./gradlew test` on every push/PR touching the package
(`.github/workflows/kotlin.yml`), so an engine regression fails the build.

Beyond the enumerated fixtures, `ComposePrecisionPropertyTest.kt` is the Kotlin-side
property-based precision guard — the mirror of `test/source-trace.pbt.test.ts` (kotest
`io.kotest.property`, `checkAll` + an `Arb` running in-process inside `./gradlew test`).
It generates synthetic Compose control snippets (`Image`/`Icon`, each with/without a
`contentDescription`, with/without a naming `semantics {}` block, wrapped in varied
interactive/nesting contexts) and asserts correct-tier-or-opaque over hundreds of
inputs. **New Compose rules must widen the `Arb`** — add the new shape to
`ComposeSnippet` + `renderSnippet` and its ground truth to `labeled`/`expectedSeverity`,
mirroring the resolver rule "extend its generators when you add resolver capability."
Every generated shape must stay syntactically valid Kotlin the PSI parser accepts.

## If you touched the resolver or enforce rules — run the real-world gate

"The resolver" = `src/source-trace.ts`, `src/resolve-components.ts`,
`src/registry.ts`. "Enforce rules" = `src/enforce.ts`, `src/suppression-ranges.ts`.

These change how the checker behaves on real code, so the unit suite is not
enough. Run the corpus regression gate:

```
pnpm matrix:check          # re-scans 31 SHA-pinned real repos, diffs vs baseline.json
```

It exits non-zero if the checker's results moved on any repo. **A delta is not
automatically a bug** — read it:

- New/changed findings that are **real accessibility problems now caught** →
  intended. Re-bless: `pnpm matrix:baseline`, then commit the updated
  `baseline.json` **in the same PR** as your code change.
- New findings that are **false positives**, or **coverage that dropped** →
  regression. Fix the code before finishing.

Never run `matrix:baseline` to silence a delta you have not understood — the
committed `baseline.json` is the record that makes real-world drift visible in
review. Re-blessing blindly defeats the entire mechanism.

`pnpm matrix:check --no-run` re-diffs the existing `results/` without the
~minutes re-scan (useful for re-reading a delta).

## The precision invariant (why the resolver is conservative)

The resolver must map a wrapper to the **correct** host element **or stay
opaque** — it must **never** map to the *wrong* host. A wrong host makes
jsx-a11y run the wrong rules at the call site and produces false positives,
which is the failure mode that gets an a11y tool uninstalled. Opaque is always
safe; wrong-host is a bug. This invariant is guarded by
`test/source-trace.pbt.test.ts` (property-based, ~700 generated wrappers) — keep
it green, and extend its generators when you add resolver capability.

## Conventions

- Each feature ships with its test, co-located in `test/` (e.g. a new enforce
  rule → a case in `test/enforce.test.ts` + a fixture in `test/fixtures/`).
- The corpus is SHA-pinned (`experiments/stack-matrix/manifest.json`); the only
  thing that may move the baseline numbers is this checker's own code.
- **Dir-level scan tests own a dedicated fixture subtree — never assert the
  *global contents* of a shared fixture dir.** A test that scans a directory and
  asserts its global findings ("exactly N findings", "only `X.prefab` fires", a
  total count) is coupled to *every* file in that dir. When the dir is shared
  across rules/features (e.g. `test/fixtures/unity-project/`), a parallel PR that
  adds an unrelated fixture to it silently invalidates that assertion: each PR is
  green alone, but the combined `main` goes red — a cross-PR collision no per-PR
  review gate can see (#84; same class as #77's ADR-number collision). So give
  such a test its **own** fixture subtree that no sibling mutates (e.g.
  `test/fixtures/unity-color-only-project/`, `test/fixtures/unity-projects/aggregate/`),
  and reserve global-content assertions for that owned dir. A per-file test
  (scan one named fixture) is already immune and needs no dedicated dir. The
  broader systemic guard for this class — a post-merge combined-tree test gate
  that runs the suite on the *merge result* of fanned-out PRs — is tracked under
  #77 / #84 for a future plan-epic; this convention is the per-test half.

## Library patterns (read before writing code against these libs)

Source-grounded pattern docs live in `.patterns/<subject>/`. Read the relevant
file before using the library — they exist to stop API hallucination.

### `@shopify/liquid-html-parser` — the Liquid → AST parser (Shopify producer, #47/L1)

Before parsing `.liquid`, read `.patterns/liquid-html-parser/index.md`.

| Task | Read |
|------|------|
| Parse a `.liquid` string to an AST | `.patterns/liquid-html-parser/parsing.md` → `node-taxonomy.md` |
| Decide attribute present vs dynamic vs absent (the precision seam) | `.patterns/liquid-html-parser/attributes.md` |
| Walk/visit nodes, read source positions | `.patterns/liquid-html-parser/traversal.md` |

### `@shopify/theme-check-common` — authoring static checks (Shopify producer, #47/L2)

Before writing a structural-absence rule, read `.patterns/theme-check-common/index.md`.

| Task | Read |
|------|------|
| Author a check (visitor over the AST) | `.patterns/theme-check-common/check-definition.md` → `visitor-api.md` |
| Report a finding with a location/severity | `.patterns/theme-check-common/reporting-offenses.md` |
| Prior art: missing-attribute checks (img alt) | `.patterns/theme-check-common/html-attribute-checks.md` |

### `@effect/cli` — the CLI framework (`check-shopify`, #47/L3, and existing commands)

Before adding/altering a command, read `.patterns/effect-cli/index.md`.

| Task | Read |
|------|------|
| Define a command + handler | `.patterns/effect-cli/command.md` |
| Positional args / named flags | `.patterns/effect-cli/args.md`, `options.md` |
| Wire a subcommand into the root | `.patterns/effect-cli/subcommands.md` → `running.md` |

### SARIF 2.1.0 — the finding-interchange format (the SARIF renderer's output)

Before emitting or changing SARIF, read `.patterns/sarif/index.md`. Grounded in
the OASIS SARIF 2.1.0 spec + `microsoft/sarif-sdk` — library truth, not our
renderer.

| Task | Read |
|------|------|
| Shape a `result` (message, level/kind, locations, fingerprints) | `.patterns/sarif/result-object.md` |
| Propose a fix (`fixes[]` → artifactChanges → replacements) | `.patterns/sarif/fixes.md` |
| Point a finding at a second spot (`relatedLocations[]`, embedded links) | `.patterns/sarif/related-locations.md` |
| Decide auto-fixable vs advisory / what Copilot Autofix reads | `.patterns/sarif/autofix-consumption.md` |

### CI runners — running a published image as a build step (any CI/CD)

Before writing a runner config that pulls and runs a Docker image (GitLab CI,
CircleCI, Buildkite primary; Jenkins, Bitbucket secondary), read
`.patterns/ci-runners/index.md`. These are tool-agnostic — they teach how each
CI system runs *any* image, injects a secret, exposes git/PR context, controls
clone depth, and turns an exit code into a build result.

| Task | Read |
|------|------|
| Run the tool image as a build step | `.patterns/ci-runners/run-docker-image.md` |
| Inject a masked secret / API token | `.patterns/ci-runners/secrets-and-env.md` |
| Read commit SHA / branch / PR number / base branch | `.patterns/ci-runners/ci-context.md` |
| Get enough clone history for a `git diff base...head` | `.patterns/ci-runners/checkout-depth.md` |
| Make findings fail the build (or only warn) | `.patterns/ci-runners/exit-codes.md` |

### GitHub Actions — authoring a native action (metadata, docker, SARIF)

Before authoring or editing an `action.yml`, wiring how the action is invoked via
`uses:`, releasing it for consumers, or uploading SARIF to code scanning, read
`.patterns/github-actions/index.md`. These are platform canon derived from
GitHub's own Actions docs — they teach GitHub Actions itself, not any one action.

| Task | Read |
|------|------|
| Understand where `uses:` finds an action (root vs subdir vs local vs docker) | `.patterns/github-actions/uses-resolution.md` |
| Write/edit an `action.yml` (schema + the three action types) | `.patterns/github-actions/action-metadata.md` |
| Author a Docker container action (image, args, `INPUT_*`, Dockerfile rules) | `.patterns/github-actions/docker-actions.md` |
| Release an action so consumers pin `@v1` / `@<sha>`; publish to Marketplace | `.patterns/github-actions/publishing-and-pinning.md` |
| Upload SARIF to code scanning (permissions + checkout) | `.patterns/github-actions/sarif-upload.md` |

### Release tooling — versioning + publishing from commit history

Before wiring release automation (a release workflow, a version-bump config, an
image-pin auto-repin), read `.patterns/release-tooling/index.md`. Library-derived
canon from the Conventional Commits spec, `googleapis/release-please`, and
`changesets/changesets` — the release *model* to reach for, not any wired
workflow. Records the release-please-over-changesets decision for a single package.

| Task | Read |
|------|------|
| Wire release automation / config / an `extra-files` image-pin auto-repin | `.patterns/release-tooling/release-please.md` |
| Decide which commit types bump (and how) / enforce the message format | `.patterns/release-tooling/conventional-commits.md` |
| Weigh the multi-package alternative / justify not adopting it | `.patterns/release-tooling/changesets.md` |
