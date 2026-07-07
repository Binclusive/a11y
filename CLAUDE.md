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
