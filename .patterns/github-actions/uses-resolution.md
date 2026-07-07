# How `uses:` resolves an action

`uses:` names *which action* a workflow step runs and *from where*. GitHub resolves
the reference to a **metadata file** — `action.yml` or `action.yaml` — and the reference
form dictates **where GitHub looks for that file**. Get the form wrong and the action is
unreachable even though the file exists in the repo: the single most common authoring
mistake is publishing metadata under a root filename that no reference form can address.

## Approaches

Every `uses:` value is one of four forms. The form determines the lookup path.

### Public action at a repository root

**When to use:** the action's metadata file lives at the **root** of its own repository.

**Pattern:**

```yaml
jobs:
  my_job:
    steps:
      # {owner}/{repo}@{ref}
      - uses: actions/checkout@v6        # a specific version tag
      - uses: some-owner/some-action@main # a branch
      - uses: some-owner/some-action@e2f20e6...  # a full commit SHA
```

GitHub looks for `action.yml` (or `action.yaml`) at the **root of `{owner}/{repo}`** at
`{ref}`. Nothing else in the repo is consulted for the lookup.

**Gotchas:**
- The file must be named exactly `action.yml` or `action.yaml`. A root file named anything
  else (`my-action.yml`, `build.yml`) is **not** reachable by this form — see Anti-patterns.
- `{ref}` is required for actions in other repositories. There is no implicit default ref.

### Public action in a subdirectory

**When to use:** one repository ships **multiple** actions, or the action's metadata is
not at the repo root.

**Pattern:**

```yaml
jobs:
  my_job:
    steps:
      # {owner}/{repo}/{path}@{ref}
      - uses: some-owner/monorepo/lint@v1
      - uses: some-owner/monorepo/deploy@v1
```

GitHub looks for `action.yml`/`action.yaml` **inside `{path}`** — here `lint/action.yml`
and `deploy/action.yml` — at `{ref}`. `{path}` may be nested (`tools/ci/scan`).

**Gotchas:**
- `{path}` is a **directory**, never the metadata filename. `owner/repo/lint@v1` resolves
  `lint/action.yml`; there is no way to point at an arbitrarily-named file.
- This is the correct way to expose several actions from one repo — one directory each.

### Local action in the same repository

**When to use:** the action lives in the **same repository** as the workflow calling it.

**Pattern:**

```yaml
jobs:
  my_job:
    runs-on: ubuntu-latest
    steps:
      # A local action is not fetched — it must already be on disk.
      - uses: actions/checkout@v6
      # ./path — a directory relative to $GITHUB_WORKSPACE
      - uses: ./.github/actions/hello-world-action
```

The path is relative (`./`) to the default working directory (`github.workspace`,
`$GITHUB_WORKSPACE`), and GitHub reads `action.yml`/`action.yaml` from that directory.

**Gotchas:**
- You **must check out the repository first** (`actions/checkout`) — a local action is read
  from the workspace on disk, not fetched from GitHub. Referencing it before checkout fails.
- No `@{ref}` — a local action is always the code from the current commit.
- If a step checks the repo out to a non-default location, the `./` path must be updated.

### Docker image from a registry

**When to use:** run a **published container image** directly, with no `action.yml` at all.

**Pattern:**

```yaml
jobs:
  my_job:
    steps:
      # docker://{host}/{image}:{tag}
      - uses: docker://gcr.io/cloud-builders/gradle
```

GitHub pulls the named image and runs it. There is no metadata-file lookup — the image
*is* the action. Docker images run only on Linux runners.

**Gotchas:**
- The `docker://` scheme is literal. Omitting it turns the value into a repo reference.
- Inputs cannot be declared (no metadata file); pass configuration via `with:`/`env:` that
  the image reads, or via `args`.

## `{ref}` — what a version reference may be

`{ref}` is a **branch name, tag, or commit SHA**. When a tag and a branch share a name, the
**tag takes precedence**. A full commit SHA is the safest, most reproducible choice — a tag
or branch can be force-moved to different code under the same name.

## Decision guide

| Situation | Form | GitHub reads |
|---|---|---|
| Action's metadata at its repo root | `owner/repo@ref` | root `action.yml`/`action.yaml` |
| One repo shipping several actions | `owner/repo/path@ref` | `path/action.yml`/`action.yaml` |
| Action in the caller's own repo | `./path/to/dir` | `path/to/dir/action.yml` (after checkout) |
| Run a published container directly | `docker://host/image:tag` | nothing — the image is the action |

## Rules

- The metadata file is **always** named `action.yml` or `action.yaml`. The reference form
  chooses the **directory**; the filename is never part of the reference.
- `owner/repo@ref` reads the **root** of the repo. To address a non-root file, the file must
  sit in a directory and be reached with `owner/repo/path@ref`.
- Local (`./`) references require a prior checkout and take no `@ref`.
- Pin third-party actions to a full commit SHA when reproducibility or supply-chain safety
  matters; a tag can be moved.

## Anti-patterns

| Don't do this | Why it breaks |
|---|---|
| Put metadata at the repo root under a custom name (`my-action.yml`) and expect `owner/repo@ref` to find it | `owner/repo@ref` reads **only** `action.yml`/`action.yaml` at the root. A differently-named root file is unreachable — no reference form can point at a specific root filename. |
| `uses: owner/repo/my-action.yml@ref` | The segment after the repo is a **directory** path, not a filename. GitHub appends `/action.yml` to it and looks for `my-action.yml/action.yml`. |
| `uses: ./.github/actions/foo` without an earlier `actions/checkout` | A local action is read from the workspace on disk; with nothing checked out, the directory does not exist. |
| Add `@ref` to a local (`./`) reference | Local actions are always the current commit; a ref on a `./` path is invalid. |

## See also

- [action-metadata.md](./action-metadata.md) — what goes inside the `action.yml` that these forms resolve to.
- [publishing-and-pinning.md](./publishing-and-pinning.md) — the release side of `@ref`: how consumers pin `@v1` / `@<sha>`.
