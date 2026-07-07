# changesets

The release model where the version bump is **declared per-PR in a file** rather
than inferred from commit messages. A contributor decides, at contribution time,
which packages a change affects and how much to bump each, and commits that
decision as a `.changeset/*.md` file. Its home turf is the **multi-package
monorepo** with human-curated changelogs. This doc documents it for the
[decision](./index.md#decision--release-please-over-changesets-for-a-single-package)
— *when it wins and why a single package does not need it* — not because it is
the adopted tool.

Source: the [`changesets/changesets`](https://github.com/changesets/changesets)
docs (`intro-to-using-changesets`, `adding-a-changeset`).

## The per-PR changeset model

A **changeset** is a small file capturing three things about a change (from
"What is a changeset?"):

- **what** needs releasing (which packages),
- **the bump type** for each (a SemVer `major`/`minor`/`patch`),
- **the changelog entry** prose.

The flow has three moves:

1. **Add** — while making the change, the contributor runs `changeset` and
   answers prompts (which packages, which bump each, a summary). This writes a
   markdown file with YAML front matter under `.changeset/`. Multiple changesets
   can accumulate across many PRs.
2. **Version** — when a release is ready, `changeset version` consumes all
   pending `.changeset/*.md` files: it bumps each package's `package.json`,
   folds the summaries into each `CHANGELOG.md`, and deletes the consumed
   changeset files.
3. **Publish** — `changeset publish` publishes the newly-versioned packages to
   the registry and pushes tags.

## The changeset file

`changeset` (or `pnpm changeset` / `yarn changeset` / `npx @changesets/cli`)
writes a uniquely-named markdown file — the front matter maps each affected
package to its bump; the body is the changelog prose:

```markdown
---
"@scope/pkg-a": minor
"@scope/pkg-b": patch
---

Add the retry API and fix the adjacent off-by-one.
```

The contributor commits this file with the PR. It is a **deliberate, authored
artifact** — the human states the bump and writes the changelog line, rather than
a tool inferring both from the commit type.

## When changesets is the right tool

- **Multi-package monorepo.** Each `.changeset/*.md` can bump several packages by
  different amounts in one shot, and changesets propagates bumps to dependent
  packages within the repo automatically. Independent per-package version lines
  are its core competency.
- **Human-curated changelogs.** The changelog entry is written by the author at
  contribution time, not synthesised from commit subjects — better prose when the
  changelog is a first-class user-facing document.
- **Bump intent decoupled from commit style.** Teams that do not enforce
  Conventional Commits can still get precise releases, because the bump is
  declared explicitly in the file rather than parsed from the message.

## Why not changesets for a single package

- The whole value — *independent per-package* versioning — collapses to a single
  version line, which the commit history already determines.
- The `.changeset/*.md`-per-PR step is **added ceremony**: a file to write,
  review, and merge on every releasable change, restating information the
  Conventional-Commit type already carries.
- With Conventional Commits in place, release-please **infers** exactly what a
  changeset would declare — with no per-PR artifact. See the
  [decision](./index.md#decision--release-please-over-changesets-for-a-single-package).

**Revisit changesets only if the repo becomes a multi-package publish.**

## changesets vs release-please

| Axis | changesets | release-please |
|---|---|---|
| Bump source | **Declared** per-PR in `.changeset/*.md` | **Inferred** from Conventional-Commit history |
| Per-PR ceremony | A changeset file per releasable change | None — the commit message is the input |
| Changelog | Human-authored in the changeset | Generated from commit subjects |
| Sweet spot | Multi-package monorepo, curated changelogs | Single package (or simple repo) already on Conventional Commits |
| Release trigger | `changeset version` then `changeset publish` | Merging the standing release PR |

## Rules

- **The bump is a committed artifact, not an inference.** No changeset file for a
  releasable change → that change is invisible at `version` time and ships
  unreleased.
- **`version` consumes and deletes** the pending changeset files — it is the
  point where declarations become concrete `package.json` + `CHANGELOG.md` edits.
- **Choose changesets for *independent per-package* versioning.** For a single
  version line, its central feature is inert and its per-PR file is pure overhead.

## Anti-patterns

| Don't do this | Why it breaks |
|---|---|
| Adopting changesets for a single-package repo already on Conventional Commits | Adds a per-PR file that restates what the commit type already implies; the multi-package payoff is absent |
| Merging a releasable change with no changeset file | `changeset version` sees nothing to bump; the change ships without a release/changelog entry |
| Hand-editing `package.json` versions instead of `changeset version` | Bypasses the tool's bump/propagation logic; dependent-package versions and the changelog drift |

## See also

- [index.md](./index.md) — the release-please-over-changesets decision this doc
  supports
- [release-please.md](./release-please.md) — the inferred-from-commits model
  chosen instead
- [conventional-commits.md](./conventional-commits.md) — the contract that makes
  inference (and thus the no-ceremony path) possible
