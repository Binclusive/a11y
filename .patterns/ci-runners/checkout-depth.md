# Checkout depth

A step that scopes work to a diff — `git diff base...head`, "only files changed
in this PR" — needs the **base commit present in local history**. CI systems
clone shallow by default to save time, so the base commit is frequently *not*
fetched, and the diff silently resolves against nothing or fails. The fix is
always one of two moves: raise the clone depth, or explicitly `git fetch` the
base ref. This doc gives each system's default depth and the knob to get enough
history.

## Approaches

### GitLab CI/CD — `GIT_DEPTH` (default 20)

**When to use:** the runner clones shallow at depth 20; raise it for diff-scoped jobs.

**Pattern:**

```yaml
variables:
  GIT_DEPTH: "0"          # 0 = full clone; or a number large enough to include the base
scan:
  script:
    - git fetch origin "$CI_MERGE_REQUEST_TARGET_BRANCH_NAME"
    - git diff "origin/$CI_MERGE_REQUEST_TARGET_BRANCH_NAME"...HEAD
```

**Gotchas:**
- Default shallow depth is **20** commits — a base older than 20 commits back is absent.
- `GIT_DEPTH: "0"` fetches full history; a finite number is enough if the base is within it.

### CircleCI — full-branch clone, manual base fetch

**When to use:** `checkout` clones the full branch (not shallow), but the base branch is a separate ref you must fetch.

**Pattern:**

```yaml
steps:
  - checkout                                  # full clone of the current branch
  - run: |
      git fetch origin main                   # base branch is not present until fetched
      git diff "$(git merge-base HEAD origin/main)"...HEAD
```

**Gotchas:**
- `checkout` is a **full branch** clone — no `GIT_DEPTH` knob and no shallow default to fight.
- The *other* branch (the base) is still not in local history until you `git fetch` it; combined with the missing base-branch var (see [ci-context.md](./ci-context.md)) this is why CircleCI diffs need the most manual setup.

### Buildkite — `depth` / clone flags (agent-dependent default)

**When to use:** the default depth depends on the agent's clone config; set it explicitly.

**Pattern:**

```yaml
steps:
  - command: |
      git fetch origin "$BUILDKITE_PULL_REQUEST_BASE_BRANCH"
      git diff "origin/$BUILDKITE_PULL_REQUEST_BASE_BRANCH"...HEAD
    env:
      BUILDKITE_GIT_CLONE_FLAGS: "-v --depth=50"   # or set the step's checkout depth
```

**Gotchas:**
- There is no fixed shallow default — it depends on the agent's `BUILDKITE_GIT_CLONE_FLAGS` / `BUILDKITE_GIT_FETCH_FLAGS`. Don't assume full history.
- A command step's `depth` attribute appends `--depth=N` to those flags; set the flags directly for full control.

### Jenkins — full by default, `CloneOption` for shallow

**When to use:** Git plugin clones full history by default; shallow is an opt-in you may need to reverse.

**Pattern:**

```groovy
steps {
  sh '''
    git fetch origin "$CHANGE_TARGET"
    git diff "origin/$CHANGE_TARGET"...HEAD
  '''
}
```

**Gotchas:**
- Default is a **full** clone, so the base is usually reachable once fetched.
- If someone enabled "Advanced clone behaviours" / the `CloneOption` extension (`shallow: true, depth: N`), history is truncated — a diff against an older base then needs the base fetched or shallow disabled.

### Bitbucket Pipelines — `clone: depth` (default 50)

**When to use:** the default clone is shallow to the last 50 commits; raise it for older bases.

**Pattern:**

```yaml
pipelines:
  pull-requests:
    '**':
      - step:
          clone:
            depth: full          # or an integer larger than the default 50
          script:
            - git diff "origin/$BITBUCKET_PR_DESTINATION_BRANCH"...HEAD
```

**Gotchas:**
- Default depth is the **last 50 commits**; a base older than that is absent until you raise `depth` or fetch it.
- `clone: depth: full` fetches everything; an integer is enough when the base is within it.

## Decision guide

| System | Default clone | Knob to get more history |
|---|---|---|
| GitLab | Shallow, depth 20 | `GIT_DEPTH` var (`"0"` = full) |
| CircleCI | Full branch (base ref still absent) | `git fetch origin <base>` |
| Buildkite | Agent-dependent | `BUILDKITE_GIT_CLONE_FLAGS` / step `depth` |
| Jenkins | Full | (reverse `CloneOption` shallow if set) |
| Bitbucket | Shallow, last 50 | `clone: depth:` (int or `full`) |

## Rules

- A diff against a base needs that **base commit in local history** — a shallow clone that stops before the base makes `git diff base...head` wrong or empty.
- Reading a base-branch **name** from a CI var (see [ci-context.md](./ci-context.md)) does not put that branch in history — `git fetch origin <base>` first.
- Prefer `git fetch` of just the base ref over a full clone when history is deep — it is cheaper than depth `0`/`full` and enough for a diff.
- Buildkite has no fixed default — treat depth as unknown and set it explicitly for any diff-scoped step.

## Anti-patterns

| Don't do this | Why it breaks |
|---|---|
| `git diff origin/main...HEAD` on a default shallow clone | The base commit may be beyond the shallow horizon; diff is empty or errors |
| Reading `CHANGE_TARGET` / `..._BASE_BRANCH` then diffing without fetching it | The base branch ref isn't in local history until fetched |
| Assuming Buildkite has full history | Its depth is agent-config-dependent; the base may be absent |
| Setting depth `0`/`full` on every job to be safe | Slow on deep repos; a targeted `git fetch <base>` is enough |

## See also

- [ci-context.md](./ci-context.md) — the base-branch name to fetch (and CircleCI's missing var)
- [run-docker-image.md](./run-docker-image.md) — where the checkout runs relative to the tool container
