# CI context environment variables

A tool running in CI needs to know what it is looking at: the commit SHA, the
branch, and — when the pipeline was triggered by a pull/merge request — the PR
number and the **base branch** it targets. Every system exposes these as
predefined environment variables, but the names are system-specific and are
*not* interchangeable. Two traps recur: the PR variables are only populated in a
PR-triggered pipeline (empty on a plain branch build), and CircleCI has **no
base-branch variable at all**.

## Approaches

### GitLab CI/CD — `CI_*`

**When to use:** any GitLab job; the `CI_MERGE_REQUEST_*` vars require an MR pipeline.

**Pattern:**

```yaml
scan:
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"   # gate MR-only logic
  script:
    - echo "sha=$CI_COMMIT_SHA branch=$CI_COMMIT_REF_NAME"
    - echo "mr=$CI_MERGE_REQUEST_IID base=$CI_MERGE_REQUEST_TARGET_BRANCH_NAME"
```

- Commit: `CI_COMMIT_SHA`, short `CI_COMMIT_SHORT_SHA`
- Branch: `CI_COMMIT_BRANCH` / `CI_COMMIT_REF_NAME`; default branch `CI_DEFAULT_BRANCH`
- MR number: `CI_MERGE_REQUEST_IID`; source `CI_MERGE_REQUEST_SOURCE_BRANCH_NAME`
- **Base/target: `CI_MERGE_REQUEST_TARGET_BRANCH_NAME`**; diff base SHA `CI_MERGE_REQUEST_DIFF_BASE_SHA`

**Gotchas:**
- `CI_MERGE_REQUEST_*` are only set when `CI_PIPELINE_SOURCE == "merge_request_event"`; unset in branch pipelines.
- `CI_COMMIT_BRANCH` is unset in an MR pipeline — use `CI_COMMIT_REF_NAME` for the source branch there.

### CircleCI — `CIRCLE_*` (no base-branch var)

**When to use:** any CircleCI job; note the base branch must be derived, not read.

**Pattern:**

```yaml
steps:
  - run: |
      echo "sha=$CIRCLE_SHA1 branch=$CIRCLE_BRANCH pr=$CIRCLE_PULL_REQUEST"
      # No base-branch var exists — derive it against the default branch:
      git fetch origin main
      BASE_SHA="$(git merge-base HEAD origin/main)"
```

- Commit: `CIRCLE_SHA1`
- Branch: `CIRCLE_BRANCH`
- PR: `CIRCLE_PULL_REQUEST` (a **URL**, not a number)
- Base branch: **none** — derive via `git merge-base`

**Gotchas:**
- `CIRCLE_PULL_REQUEST` is the PR **URL**; there is no clean PR-number var (`CIRCLE_PR_NUMBER` is deprecated and only set for forked PRs).
- There is **no target/base-branch variable** — you must `git fetch` the base and compute `git merge-base` yourself. This is the most awkward system for diff-scoped work.

### Buildkite — `BUILDKITE_*`

**When to use:** any Buildkite command step.

**Pattern:**

```bash
echo "sha=$BUILDKITE_COMMIT branch=$BUILDKITE_BRANCH"
# BUILDKITE_PULL_REQUEST is the PR number, or the string "false" outside a PR build:
if [[ "$BUILDKITE_PULL_REQUEST" != "false" ]]; then
  echo "pr=$BUILDKITE_PULL_REQUEST base=$BUILDKITE_PULL_REQUEST_BASE_BRANCH"
fi
```

- Commit: `BUILDKITE_COMMIT`
- Branch: `BUILDKITE_BRANCH`
- PR number: `BUILDKITE_PULL_REQUEST` (or the literal `false`)
- **Base: `BUILDKITE_PULL_REQUEST_BASE_BRANCH`**; PR source repo `BUILDKITE_PULL_REQUEST_REPO`

**Gotchas:**
- `BUILDKITE_PULL_REQUEST` is the string `"false"` (not empty) when the build is not a PR build — test against `"false"`.

### Jenkins — Git plugin + multibranch `CHANGE_*`

**When to use:** the `CHANGE_*` vars exist only in a **multibranch PR** job.

**Pattern:**

```groovy
steps {
  sh 'echo "sha=$GIT_COMMIT branch=$GIT_BRANCH"'
  script {
    if (env.CHANGE_ID) {   // present only in a multibranch PR build
      sh 'echo "pr=$CHANGE_ID base=$CHANGE_TARGET source=$CHANGE_BRANCH"'
    }
  }
}
```

- Commit: `GIT_COMMIT`; branch: `GIT_BRANCH` / `GIT_LOCAL_BRANCH`
- PR number: `CHANGE_ID`; **base: `CHANGE_TARGET`**; source `CHANGE_BRANCH`; `BRANCH_NAME`, `CHANGE_URL`

**Gotchas:**
- `CHANGE_*` are only populated in a multibranch pipeline's PR job; a plain freestyle or single-branch job never sets them. Guard on `env.CHANGE_ID`.

### Bitbucket Pipelines — `BITBUCKET_*`

**When to use:** the `BITBUCKET_PR_*` vars require a `pull-requests:` pipeline.

**Pattern:**

```yaml
pipelines:
  pull-requests:
    '**':
      - step:
          script:
            - echo "sha=$BITBUCKET_COMMIT branch=$BITBUCKET_BRANCH"
            - echo "pr=$BITBUCKET_PR_ID base=$BITBUCKET_PR_DESTINATION_BRANCH"
```

- Commit: `BITBUCKET_COMMIT`; branch: `BITBUCKET_BRANCH`
- PR number: `BITBUCKET_PR_ID`; **base: `BITBUCKET_PR_DESTINATION_BRANCH`** (+ `BITBUCKET_PR_DESTINATION_COMMIT`)

**Gotchas:**
- `BITBUCKET_PR_*` are only set under a `pull-requests:` pipeline; a `default`/`branches:` pipeline leaves them unset.

## Decision guide

| System | Commit | Branch | PR number | Base branch |
|---|---|---|---|---|
| GitLab | `CI_COMMIT_SHA` | `CI_COMMIT_REF_NAME` | `CI_MERGE_REQUEST_IID` | `CI_MERGE_REQUEST_TARGET_BRANCH_NAME` |
| CircleCI | `CIRCLE_SHA1` | `CIRCLE_BRANCH` | `CIRCLE_PULL_REQUEST` (URL) | **none — derive** |
| Buildkite | `BUILDKITE_COMMIT` | `BUILDKITE_BRANCH` | `BUILDKITE_PULL_REQUEST` | `BUILDKITE_PULL_REQUEST_BASE_BRANCH` |
| Jenkins | `GIT_COMMIT` | `GIT_BRANCH` | `CHANGE_ID` | `CHANGE_TARGET` |
| Bitbucket | `BITBUCKET_COMMIT` | `BITBUCKET_BRANCH` | `BITBUCKET_PR_ID` | `BITBUCKET_PR_DESTINATION_BRANCH` |

## Rules

- PR/MR variables are populated **only** in a PR-triggered pipeline. On a plain branch build they are empty (or `"false"` in Buildkite) — fall back to comparing the branch against the default branch (`CI_DEFAULT_BRANCH`, `main`, etc.).
- Gate PR-only logic on the trigger: GitLab `CI_PIPELINE_SOURCE == "merge_request_event"`, Bitbucket `pull-requests:`, Jenkins `env.CHANGE_ID`, Buildkite `BUILDKITE_PULL_REQUEST != "false"`.
- The base-branch var is a **name**, not a SHA. Resolving a diff still needs that ref fetched into local history — see [checkout-depth.md](./checkout-depth.md).

## Anti-patterns

| Don't do this | Why it breaks |
|---|---|
| Reading `CI_MERGE_REQUEST_*` in a branch pipeline | Unset outside an MR pipeline; the value is empty |
| Treating `CIRCLE_PULL_REQUEST` as a PR number | It is a URL; parse it or use `git merge-base`, don't pass it as an id |
| Expecting a CircleCI base-branch var | There is none — derive the base with `git merge-base HEAD origin/<default>` |
| Testing Buildkite PR context with `-z "$BUILDKITE_PULL_REQUEST"` | It is the literal `"false"`, not empty, outside a PR build |

## See also

- [checkout-depth.md](./checkout-depth.md) — fetching the base ref so a diff against it resolves
- [run-docker-image.md](./run-docker-image.md) — these vars are visible to the image once running (Buildkite needs `propagate-environment`)
