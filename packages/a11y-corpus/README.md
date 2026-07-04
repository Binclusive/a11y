# @binclusive/a11y-corpus (PRIVATE)

The proprietary audit corpus — the **moat**. Distilled from real audits of ~26
orgs. **Never publish to public npm.** Ships only to the GitHub Packages private
registry (`https://npm.pkg.github.com`), authenticated with a GitHub token.

## What's here

- `data/corpus-snapshot.json` — the transitional SC-level frequency snapshot (org
  integers + SC-generic fixes).
- `data/corpus/patterns-*.json` — the distilled, anonymized, k>=3 failure patterns.
- `data/corpus/ledger-*.json` — the no-silent-drops distillation provenance.
- `data/clusters/*.json` — the frozen offline LLM cluster assignments.
- `src/distill/**` — the distillation pipeline that PRODUCES the data above from a
  raw (gitignored) corpus export.

## Relationship to `@binclusive/a11y`

The OSS engine declares this package as an **optionalDependency** and loads its
JSON at runtime via a guarded `createRequire`. Present → full audit-frequency
enrichment (`source:"audit"`, real tiers). Absent → the engine degrades to
baseline-only coverage (`source:"baseline"` / `tier:"unknown"`) and never throws.

The frequency-tier vocabulary (`tierForOrgs`, thresholds) is **not** here — it is
single-sourced in the public engine (`@binclusive/a11y/src/frequency-tier`), which
this package imports. The mapping is public; only the org counts and patterns are.

## Regenerate the data

```
tsx src/distill/run-distill.ts <raw-export.json> <SC> [SC...]
```

The raw export is customer-identifying and gitignored — never commit it. Only the
anonymized, k>=3-gated outputs (`data/corpus/*`, `data/clusters/*`) are committed.
