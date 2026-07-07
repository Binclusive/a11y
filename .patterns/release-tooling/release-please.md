# release-please

The automation that turns a Conventional-Commit history into releases with no
per-PR ceremony. It runs on every push to the default branch and maintains a
single open **release PR**; when that PR merges, it tags the version and cuts the
GitHub release. This doc is the config and mechanism surface — the release-PR
model, how the next version is inferred, the manifest config, `extra-files` (how
a version string is synced into a non-package file), and the workflow shape.

Source: the [`googleapis/release-please`](https://github.com/googleapis/release-please)
docs (`README`, `docs/manifest-releaser.md`, `docs/customizing.md`) and the
[`googleapis/release-please-action`](https://github.com/googleapis/release-please-action)
README.

## The release-PR model

release-please does not release on every merge. It maintains **one standing
release PR** that it keeps rebased against the default branch:

1. On each push to `main`, it scans commits since the last release and, from
   their Conventional-Commit types, computes the **next version** and an updated
   **CHANGELOG**.
2. It opens (or updates) a release PR containing that version bump + changelog.
   The PR accumulates until you decide to release.
3. **Merging the release PR** is the release trigger — release-please then
   creates the git tag and the GitHub release for that version.

So the version is never hand-typed: it is the deterministic output of the commit
history. Merge cadence of the release PR is the only human decision.

## Version inference

The next version is derived from the [Conventional Commits](./conventional-commits.md)
merged since the last release: `fix`→patch, `feat`→minor, a `!`/`BREAKING CHANGE`
marker→major. The highest-precedence change in the window wins. `release-as` in
config can pin an explicit next version, overriding inference (a manual escape,
not the norm).

## `release-type: node`

The **strategy** tells release-please which files hold the version and how to
format the changelog. `release-type: node` is the Node.js strategy: it expects a
`package.json` and a `CHANGELOG.md`, bumps the `version` field in `package.json`
(and the lockfile), and writes the changelog. Set it either as the action's
`release-type` input (simple case) or as `release-type` in the manifest config
(advanced case). Other strategies exist (`python`, `go`, `java`, `simple`, …);
`node` is the one for a Node package. (`docs/customizing.md`, "Strategy types".)

## The manifest config (advanced)

For anything beyond a single bare strategy, release-please uses two
source-controlled files (`docs/manifest-releaser.md`):

- **`release-please-config.json`** — the releaser config: strategy, the set of
  packages, `extra-files`, plugins.
- **`.release-please-manifest.json`** — version tracking: the last-released
  version per package path. release-please reads this to know the current
  version and writes the new one on release.

Config shape (a single-package repo has one entry keyed by `.`):

```json
{
  "release-type": "node",
  "packages": {
    ".": {
      "extra-files": [ /* see below */ ]
    }
  }
}
```

Manifest shape (tracks the current version per package path):

```json
{
  ".": "1.4.0"
}
```

The `packages` object is what makes release-please monorepo-capable: each key is
a package **path** with its own `component` name and version line. A
single-package repo is just the degenerate case — one entry under `.`.

## `extra-files` — syncing a version into a non-package file

`release-type: node` only knows to update `package.json` + the changelog. When a
version string also lives **inside another file** — e.g. an image pin like
`ghcr.io/OWNER/IMAGE:1.4.0` inside an `action.yml`, or a version in a YAML/JSON
config — `extra-files` is the mechanism that keeps it in lockstep with the
release. This is the load-bearing surface for auto-repinning a self-referential
version.

Two updaters (`docs/customizing.md`, "Updating arbitrary files"):

**Generic updater — annotate the line in place.** For arbitrary text files
(YAML, Dockerfile, action manifests), you mark the version with a **comment
annotation** and list the file in `extra-files`:

```json
{
  "release-type": "node",
  "packages": {
    ".": {
      "extra-files": [
        { "type": "generic", "path": "action.yml" }
      ]
    }
  }
}
```

Then annotate the version in `action.yml` so the updater knows what to replace:

```yaml
runs:
  using: docker
  # x-release-please-version
  image: docker://ghcr.io/OWNER/IMAGE:1.4.0
```

Annotation vocabulary (each replaces the value on **its own line**):
`x-release-please-version`, `x-release-please-major`, `x-release-please-minor`,
`x-release-please-patch`. To cover a multi-line span, open with
`x-release-please-start-version` (or `-major`/`-minor`/`-patch`) and close with a
line containing `x-release-please-end`; every version value in the block is
replaced.

**GenericJson updater — target a field by JSONPath.** For structured JSON, point
at the field directly instead of annotating:

```json
{
  "type": "json",
  "path": "path/to/file.json",
  "jsonpath": "$.path.to.version"
}
```

On each release, release-please rewrites the annotated line / targeted field to
the new version as part of the release PR — the pin never drifts from the package
version.

## The workflow shape

release-please runs as the `googleapis/release-please-action`, triggered on push
to the default branch. The action exposes outputs — `release_created`,
`tag_name`, `version`, `major`, `minor`, `patch` — that gate the publish step so
it only runs when the release PR was just merged:

```yaml
on:
  push:
    branches: [main]

permissions:
  contents: write
  pull-requests: write

jobs:
  release-please:
    runs-on: ubuntu-latest
    steps:
      - uses: googleapis/release-please-action@v4
        id: release
        with:
          # simple case: a bare strategy
          release-type: node
          # advanced case: point at the manifest config instead
          # config-file: release-please-config.json
          # manifest-file: .release-please-manifest.json

      # publish only fires when the release PR was just merged
      - uses: actions/checkout@v4
        if: ${{ steps.release.outputs.release_created }}
      # ... setup + publish, all guarded by the same `if`
```

`release_created` is the gate: on a normal push it is empty (the step only
*updates the release PR*), and it becomes truthy only on the push that **merged**
the release PR — that is the run that should tag-and-publish.

## Decision guide

| Situation | Reach for |
|---|---|
| Single package, bare strategy, nothing extra to update | Action `release-type: node` input, no config file |
| A version string lives outside `package.json` (image pin, config) | Manifest config + `extra-files` (generic / json) |
| Several independently-versioned packages in one repo | Manifest config with multiple `packages` entries |
| Need to force a specific next version once | `release-as` in config (override inference) |

## Rules

- **The version is inferred, never typed.** It is the deterministic function of
  Conventional-Commit history since the last release; keep the commits compliant
  and the bump is correct by construction.
- **Merging the release PR is the release** — nothing is tagged or published
  until that PR merges. A normal push only refreshes the pending PR.
- **`release-type` picks the strategy; `extra-files` extends it.** The strategy
  updates the language's canonical version file; anything else that embeds the
  version needs an `extra-files` entry or it silently goes stale.
- **A generic `extra-files` target must be annotated.** The updater replaces the
  value on the annotated line/block only — an unannotated version string is not
  found and not updated.
- **Gate the publish on `release_created`.** Without the `if`, the publish step
  runs on every push, not only when a release was actually cut.

## Anti-patterns

| Don't do this | Why it breaks |
|---|---|
| Hand-editing `version` in `package.json` alongside release-please | Fights the manifest's version tracking; the next run's inference conflicts with the manual bump |
| Embedding the version in an `action.yml`/config with no `extra-files` entry | The strategy only touches `package.json`; the embedded pin drifts and points at a stale image |
| A `generic` `extra-files` target without an `x-release-please-*` annotation | The updater has nothing to match; the value is left untouched |
| Running the publish step without `if: release_created` | Publishes (or attempts to) on every push, not just on release-PR merge |
| Expecting a release on every merge to `main` | release-please only *proposes* a release PR; it releases when that PR merges |

## See also

- [conventional-commits.md](./conventional-commits.md) — the commit contract the
  version inference reads
- [changesets.md](./changesets.md) — the per-PR-declaration alternative, and when
  it is the right tool instead
