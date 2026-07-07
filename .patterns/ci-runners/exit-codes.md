# Exit codes and soft-fail

The universal contract: a step's process exits non-zero → the build fails. This
is how a tool signals "I found a problem" and blocks a merge. Sometimes you want
the opposite — surface findings but let the pipeline continue (a warning gate, a
gradual rollout). Every system honours non-zero-fails-the-build by default; each
has a different escape hatch to soften it, and Bitbucket has none at the step
level.

## Approaches

### GitLab CI/CD — `allow_failure`

**When to use:** let a job fail without failing the pipeline; optionally only for specific exit codes.

**Pattern:**

```yaml
scan:
  script:
    - your-command      # non-zero fails the job by default
  allow_failure: true   # job may fail without failing the pipeline
  # or scope to specific codes:
  # allow_failure:
  #   exit_codes: [1, 2]
```

**Gotchas:**
- A bare `allow_failure: true` softens **any** non-zero exit; `allow_failure: exit_codes:` lets you distinguish "findings" (soften) from "crashed" (still fail).
- The job still shows as failed (with a warning icon) — it just doesn't block the pipeline.

### CircleCI — in-shell `set +e`

**When to use:** there is no job-level soft-fail; soften inside the `run` shell.

**Pattern:**

```yaml
steps:
  - run: |
      set +e                 # the run shell is `bash -eo pipefail`; disable exit-on-error
      your-command
      code=$?
      echo "tool exited $code"
      exit 0                 # explicitly succeed the step regardless
```

**Gotchas:**
- The `run` shell is `/bin/bash -eo pipefail` — a non-zero exit fails the step immediately unless you `set +e`.
- There is no declarative `allow_failure` equivalent; you must capture `$?` and decide in-shell.

### Buildkite — `soft_fail`

**When to use:** let a command step fail without failing the build; optionally per exit status.

**Pattern:**

```yaml
steps:
  - command: your-command
    soft_fail: true          # any non-zero passes the build (marked soft-failed)
  # or scope to specific statuses:
  # - command: your-command
  #   soft_fail:
  #     - exit_status: 1
```

**Gotchas:**
- `soft_fail: true` softens any non-zero; the list form (`exit_status:`) softens only the listed codes and still fails on others.
- The step is annotated as soft-failed, not passed — the distinction is visible in the UI.

### Jenkins — `catchError` / `returnStatus`

**When to use:** run a step that may fail while controlling the resulting build/stage result.

**Pattern:**

```groovy
steps {
  catchError(buildResult: 'SUCCESS', stageResult: 'UNSTABLE') {
    sh 'your-command'        // non-zero would normally fail the build
  }
  // or capture the code and branch on it:
  script { def code = sh(script: 'your-command', returnStatus: true) }
}
```

**Gotchas:**
- `sh` fails the build on non-zero by default; `catchError` lets you set a softer `buildResult` (e.g. keep `SUCCESS`, mark the stage `UNSTABLE`).
- `sh(returnStatus: true)` returns the exit code instead of throwing — use it to branch in Groovy.

### Bitbucket Pipelines — `|| true` (no native soft-fail)

**When to use:** always — Bitbucket has no per-step soft-fail keyword; handle it in the script.

**Pattern:**

```yaml
pipelines:
  default:
    - step:
        script:
          - your-command || true          # swallow the non-zero so the step passes
          # or capture and decide:
          - your-command || echo "findings (exit $?), continuing"
```

**Gotchas:**
- A step fails on the **first** non-zero command; there is no `allow_failure`/`soft_fail` equivalent.
- `|| true` masks *all* failure including a genuine crash — capture `$?` and branch if you need to distinguish findings from a broken tool.

## Decision guide

| System | Default | Soft-fail escape |
|---|---|---|
| GitLab | Non-zero fails job | `allow_failure: true` / `allow_failure: exit_codes:` |
| CircleCI | Non-zero fails step (`bash -eo pipefail`) | in-shell `set +e` + explicit `exit 0` |
| Buildkite | Non-zero fails step | `soft_fail: true` / `soft_fail: [{exit_status: N}]` |
| Jenkins | Non-zero fails build | `catchError(buildResult:…)` / `sh(returnStatus: true)` |
| Bitbucket | First non-zero fails step | `cmd || true` (no native keyword) |

## Rules

- Non-zero exit fails the build in **every** system by default — this is the signal a tool uses to block a merge; don't defeat it unless you deliberately want a warning-only gate.
- Prefer a code-scoped soften (`exit_codes:` / `exit_status:` / branch on `$?`) over a blanket one, so a real crash (exit 2, segfault) still fails while findings (exit 1) only warn.
- A blanket soften (`allow_failure: true`, `soft_fail: true`, `|| true`, `catchError → SUCCESS`) hides genuine failures too — use it knowingly.
- CircleCI and Bitbucket have no declarative soft-fail; the escape is in the shell (`set +e`, `|| true`).

## Anti-patterns

| Don't do this | Why it breaks |
|---|---|
| `your-command || true` to "make CI green" while investigating | Swallows real crashes too; the gate silently stops protecting the branch |
| Blanket `allow_failure: true` / `soft_fail: true` when only findings should warn | A crashed/misconfigured tool now also passes — the gate is blind |
| CircleCI: expecting the step to continue after a non-zero without `set +e` | The `bash -eo pipefail` shell aborts on the first non-zero |
| Jenkins: wrapping in `catchError` but not reading the result | The build stays green even when the stage should be `UNSTABLE`/`FAILURE` |

## See also

- [run-docker-image.md](./run-docker-image.md) — the container's exit code is the step's exit code
- [ci-context.md](./ci-context.md) — deciding *when* to enforce vs warn (e.g. block on PRs, warn on branches)
