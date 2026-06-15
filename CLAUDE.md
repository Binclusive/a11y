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
