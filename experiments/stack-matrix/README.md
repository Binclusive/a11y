# stack-matrix

A reproducible harness that runs the a11y-checker across a **matrix of real OSS
React repos** spanning different design systems × frameworks, then reports
coverage and findings per cell. This is the measurement layer that makes engine
hardening data-driven: it tells you *which rule fires where, and where a single
rule dominates a repo's findings* (a likely false-positive cluster and therefore
the next thing worth a human look).

Every scan is **cold / out-of-the-box**: no `init`, no `pnpm install` on the
clone, no manual component declarations. We measure recall as a first-time user
would get it.

## Axes

- **Design system** (the search key) — `matrix.ts › DESIGN_SYSTEMS`. Each entry
  carries the npm package names we grep for across GitHub package.json files:
  MUI, Chakra, Mantine, Ant Design, Radix, Headless UI, React Aria, Base UI.
- **Framework** (detected, not searched) — `matrix.ts › detectFramework()` reads
  the cloned repo's package.json deps: `next` → next, `@remix-run/react` →
  remix, `react-router(-dom)` → react-router, `@vitejs/plugin-react(-swc)` →
  vite-react, `react-scripts` → cra, `gatsby` → gatsby, else `react`.
- **Framework backfill** (a second SEARCH axis) — `matrix.ts › FRAMEWORK_TARGETS`.
  The design-system search is star-ranked, and its winners skew
  next / react / react-router / vite-react, so **remix / cra / gatsby cells stay
  empty**. A framework-targeted pass searches each framework's own dep
  (`@remix-run/react`, `gatsby`, `react-scripts`), biases toward TypeScript repos
  (the query pairs the dep with a `tsconfig.json` match), and **gates on `.tsx`
  presence** before pinning — CRA/Gatsby apps skew heavily to `.jsx` and the
  checker is TSX-only. Survivors are tagged `source: "framework-discovered"` and
  **merged** onto the design-system manifest (deduped by repo).

## Three-step flow

```sh
pnpm matrix:discover   # GitHub code-search + seed → manifest.json (pinned)
pnpm matrix:run        # clone + cold-scan each pinned repo → results/*.json
pnpm matrix:report     # results/*.json → REPORT.md + report.csv
```

Or directly: `tsx experiments/stack-matrix/{discover,run,report}.ts`.

### 1. `discover.ts` → `manifest.json`

For each design system, `gh search code '"<dep>" filename:package.json'`
(deduped), merged with the curated `seed.json`. Each candidate is filtered
(skip archived / forks / the design-system's own monorepo / repos > 200 MB
diskUsage), ranked by stars, top 3 kept, then **pinned to a commit SHA**.
Polite: ~7s sleep between design systems (code search is ~10 req/min).

Then a **framework pass** (`FRAMEWORK_TARGETS`) over-fetches (~8 candidates),
applies the same filters plus a `.tsx`-presence gate, prefers TypeScript repos,
keeps the top 2 per framework, and **merges** them onto the design-system
manifest (dedupe by repo). Idempotent — a repo already pinned (from either pass
or a prior run) is never duplicated; `manifest.json` is rewritten each run.

### 2. `run.ts` → `results/<owner>__<name>.json`

Shallow-clones each pinned repo into `.cache/` (reused if present), finds the
source dir (the subtree with the most `.tsx`, preferring a `src/` under it —
handles monorepos), then runs
`tsx src/cli.ts check <srcDir> --json` from the plugin root. The checker
**exits non-zero on blocking findings — that is normal**; stdout is parsed
regardless. Each result = the checker's JSON plus
`{ repo, designSystem, framework, sha, tsxRoot, stars, error }`. Failures are
recorded as `{ repo, designSystem, error }` and the run continues. Each scan is
time-boxed to ~120s.

### 3. `report.ts` → `REPORT.md` + `report.csv`

- Main matrix table (one row per repo).
- Coverage grid: design system × framework.
- Rollups by design system and by framework.
- **Signal** section: repos whose findings are dominated by a single ruleId at
  high volume — candidate false-positive clusters / next hardening targets.
- Errored repos listed separately.

## Pinned vs regenerated

| File | Committed? | Notes |
|---|---|---|
| `matrix.ts`, `seed.json`, `*.ts`, `README.md` | yes | the harness source |
| `manifest.json` | yes | the pinned picks (regenerate with `matrix:discover`) |
| `REPORT.md`, `report.csv` | yes | the latest measurement snapshot |
| `.cache/` (clones) | **no** | `.gitignore`d — reproducible from `manifest.json` |
| `results/` (raw per-repo JSON) | **no** | `.gitignore`d — regenerate with `matrix:run` |

## Notes

- `discover` re-running may shift picks as GitHub's index and star counts move —
  that is why we pin SHAs in the manifest. `run` always clones exactly what is
  pinned.
- Seed entries are always kept even if a design system's discovery comes up dry.
