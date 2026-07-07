# react-doctor-benchmark

A reproducible head-to-head between **a11y-checker** and **[millionco/react-doctor](https://github.com/millionco/react-doctor)** — which also ships an "accessibility" audit — on the same real design-system apps, run **cold** (no `init`, no manual component declarations).

The axis under test is **component resolution**. react-doctor is jsx-a11y ported to oxlint: it sees literal `<input>` / `<a>` only, unless you hand-write `settings['jsx-a11y'].components`. a11y-checker traces design-system wrappers to their host primitive, so its rules fire inside `<Input>` / `<Button>` / a shadcn barrel. This harness makes that difference a measured finding count, not a claim.

The current snapshot lives in **[REPORT.md](./REPORT.md)**.

## Run

```sh
tsx experiments/react-doctor-benchmark/run.ts
```

For each target it: shallow-clones the repo into `.cache/`, runs **a11y-checker** (`src/cli.ts check <src> --json`) and **react-doctor** (`npx react-doctor@latest --json …`) over the same `.tsx` root, normalizes both to `{file, line, rule}`, diffs them by call site, and writes `results/<owner>__<name>.json`.

> react-doctor runs via `npx` — first invocation downloads the package and a one-time oxlint binary, so the first run is slow and needs network. Both tools exit non-zero when they find blocking issues; that is normal, stdout is parsed regardless.

## Targets

Edit `TARGETS` in `run.ts`. Each cell is `{ repo, branch, app, src }`:
- `app` — the project root react-doctor runs in (needs its `package.json` to detect the framework).
- `src` — the `.tsx` root both tools scan (the dir a11y-checker is pointed at).

Both are repo-relative. Add a row to benchmark another app; both `app` and `src` exist so a monorepo's web app can be isolated from its other workspaces.

## How the diff is computed

- **rule** is reduced to its leaf id (`jsx-a11y/heading-has-content` → `heading-has-content`) so the two tools' id schemes line up.
- **site** is `file:line`, with react-doctor's paths normalized to the same `src`-relative form a11y-checker emits.
- **shared** = a site both tools report. **only-ours / only-react-doctor** = the rest. The qualitative call (which of those are false positives vs real-but-unseen) stays human, in REPORT.md — the harness measures, it does not judge.

react-doctor's a11y findings are also filtered to those **under `src`**, so its other categories (Bugs / Maintainability / Performance / Security) and any findings outside the scanned tree don't pollute the a11y comparison; the full category breakdown is still recorded in each result's `reactDoctor.byCategory`.

## Pinned vs regenerated

| File | Committed? | Notes |
|---|---|---|
| `run.ts`, `README.md` | yes | the harness |
| `REPORT.md` | yes | the latest measurement snapshot, authored from `results/` |
| `.cache/` (clones) | **no** | `.gitignore`d — reproducible from `TARGETS` |
| `results/` (raw per-repo JSON) | **no** | `.gitignore`d — regenerate with `run.ts` |

## Notes

- The snapshot pins react-doctor's version and the target's commit SHA; re-running on a newer react-doctor or a moved branch may shift counts — record both when you refresh REPORT.md.
- This is a measurement layer, not a takedown: the goal is to learn what each tool does well. See REPORT.md's "What to adopt" for the parts of react-doctor worth borrowing.
