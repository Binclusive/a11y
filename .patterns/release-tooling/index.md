# Release tooling patterns

How a repository turns a stream of commits into a versioned, published release
without hand-editing a version number or writing a changelog by hand. Three
concerns thread together: the **commit contract** a message must follow for a
machine to read intent (Conventional Commits), the **automation** that reads
that commit history and proposes the next release (release-please), and the
**per-PR alternative** you would reach for instead when one repo publishes many
independently-versioned packages (changesets).

Every approach here traces to its own upstream source — the Conventional Commits
v1.0.0 spec, the `googleapis/release-please` docs, and the `changesets/changesets`
docs — not to any repository that adopts them. These patterns tell you *which
release model to reach for* and *what shape its config takes*; they are not a
description of a wired-up workflow.

Scope: **release-please** is the primary model (full coverage, including the
`extra-files` mechanism that syncs a version string into a non-package file).
**Conventional Commits** is the contract release-please depends on — documented
because the automation is only as correct as the commit history it reads.
**changesets** is documented for the *decision* below (when it is the right tool
and why a single-package repo does not need it), not because it is adopted.

## Decision — release-please over changesets for a single package

For a **single published package** whose history already follows Conventional
Commits, reach for **release-please**:

- release-please **infers** the next version from commit history — `fix`→patch,
  `feat`→minor, a breaking marker→major — and opens a release PR automatically.
  There is **zero per-PR ceremony**: a compliant commit message *is* the release
  input.
- changesets requires a **per-PR artifact** — a contributor runs `changeset` and
  commits a `.changeset/*.md` file declaring the bump and changelog entry for
  each PR. That ceremony buys **independent per-package versioning** and
  **human-curated changelog prose**, which is exactly what a **multi-package
  monorepo** needs and a single package does not.
- The contract is already in place (the commits are conventional), so
  release-please's inference is free; changesets' hand-authored changeset files
  would be redundant ceremony over the same information.

**Reach for changesets only if the repo becomes a multi-package publish** —
several packages released on independent version lines from one repo. Until
then, release-please is the lower-ceremony correct-by-construction choice.

## Index

| Doc | Concern | Read when |
|---|---|---|
| [release-please.md](./release-please.md) | The release-PR automation: config, version inference, `extra-files` | Wiring release automation or an image-pin auto-repin |
| [conventional-commits.md](./conventional-commits.md) | The commit-message contract that drives the bump | Deciding which commit types release or don't, or enforcing the format |
| [changesets.md](./changesets.md) | The per-PR changeset-file model and when it wins | Weighing the multi-package alternative, or justifying the decision above |

## Shared conventions

- Version bumps follow [SemVer](https://semver.org/): `MAJOR.MINOR.PATCH`.
  Conventional Commits and both tools map onto it identically — `fix`→patch,
  `feat`→minor, breaking→major.
- Config examples use each tool's real surface: release-please's
  `release-please-config.json` / `.release-please-manifest.json` and the
  `googleapis/release-please-action` workflow; changesets' `.changeset/*.md`
  files and `changeset` CLI.
- File paths inside config are placeholders — swap `path/to/file` and the
  package/component names for the real ones.
