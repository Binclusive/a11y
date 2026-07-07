# Secrets and environment variables

A tool image usually needs a secret at runtime — an API token, a report-upload
key. The discipline is identical everywhere: store the secret in the system's
secret store, let the runner inject it as a masked environment variable, and
never write the secret into the YAML. What differs is *where* the store lives
and how you attach it to a step. Four of the five systems have a first-class
UI-set masked variable; Buildkite deliberately has none and is the outlier.

## Approaches

### GitLab CI/CD — masked CI/CD variable

**When to use:** the default; set once in the project/group and it is injected into every job.

**Pattern:**

```yaml
# Settings → CI/CD → Variables → add API_TOKEN, tick "Mask variable".
# Optionally tick "Protect variable" to expose it only on protected branches/tags.
scan:
  image: ghcr.io/OWNER/IMAGE:TAG
  script:
    - your-command --token "$API_TOKEN"   # auto-injected as an env var; masked in logs
```

**Gotchas:**
- Masking has value-format constraints (length, character set); a value that can't be masked is rejected or logged in clear — check the variable saved as masked.
- "Protect variable" hides it from non-protected branches — a job on a feature branch then sees an empty value.

### CircleCI — context or project env var

**When to use:** project var for a single project; **context** to share a secret across projects in an org.

**Pattern:**

```yaml
# Project var: Project Settings → Environment Variables → API_TOKEN.
# Context: Org Settings → Contexts → create, add API_TOKEN, attach in the workflow.
workflows:
  build:
    jobs:
      - scan:
          context: shared-secrets    # attaches the context's vars to the job
jobs:
  scan:
    docker:
      - image: ghcr.io/OWNER/IMAGE:TAG
    steps:
      - run: your-command --token "$API_TOKEN"   # masked in logs
```

**Gotchas:**
- A project env var is auto-injected; a **context** var only reaches a job whose workflow entry names the `context:`.
- Contexts can be restricted to specific security groups — a job in an unauthorized workflow won't get the values.

### Buildkite — agent environment hook / external store (outlier)

**When to use:** always — Buildkite has no built-in SaaS secret store by design.

**Pattern:**

```bash
# On the agent: hooks/environment (a sourced script), gated to the right pipeline/step.
set -euo pipefail
if [[ "$BUILDKITE_PIPELINE_SLUG" == "your-pipeline" ]]; then
  export API_TOKEN="$(read-from-your-vault)"   # e.g. Vault/AWS-SM plugin or S3 env file
fi
```

```yaml
# Pipeline: forward the exported var into the container.
steps:
  - command: your-command --token "$API_TOKEN"
    plugins:
      - docker#v5.13.0:
          image: ghcr.io/OWNER/IMAGE:TAG
          propagate-environment: true    # carries API_TOKEN into the container
```

**Gotchas:**
- The secret comes from *your* infrastructure (agent hook, encrypted S3 env file, or a Vault/AWS Secrets Manager plugin), not from Buildkite.
- Inside a container, the host env only reaches the process if you set `propagate-environment: true` or list the var under the plugin's `environment:`.
- Gate the hook on `$BUILDKITE_PIPELINE_SLUG` / `$BUILDKITE_STEP_KEY` so unrelated pipelines on the same agent don't receive the secret.

### Jenkins — credentials binding

**When to use:** Declarative Pipeline with a Secret Text credential.

**Pattern:**

```groovy
pipeline {
  agent { docker { image 'ghcr.io/OWNER/IMAGE:TAG' } }
  environment { API_TOKEN = credentials('api-token-id') }   // masked in the build log
  stages {
    stage('scan') { steps { sh 'your-command --token "$API_TOKEN"' } }
  }
}
```

**Gotchas:**
- `credentials('id')` references a credential created in Jenkins' credential store; the string is the credential **id**, not the secret.
- For finer control (e.g. username+password split) use `withCredentials([...]) { ... }` around the step instead of the `environment` block.

### Bitbucket Pipelines — secured variable

**When to use:** the default; workspace-, repository-, or deployment-scoped.

**Pattern:**

```yaml
# Repository settings → Repository variables → add API_TOKEN, tick "Secured".
pipelines:
  default:
    - step:
        image: ghcr.io/OWNER/IMAGE:TAG
        script:
          - your-command --token "$API_TOKEN"   # injected as env; masked in logs
```

**Gotchas:**
- A secured variable is masked in the log and **cannot be used to template the YAML** (no `image: $SECRET`).
- Deployment-scoped variables only exist in steps tied to that deployment environment.

## Decision guide

| System | Store | Attach mechanism |
|---|---|---|
| GitLab | CI/CD variable (masked) | Auto-injected into every job |
| CircleCI | Project var / Context | Project var auto; context via workflow `context:` |
| Buildkite | Your infra (hook / Vault / S3) | Agent env hook → `propagate-environment` |
| Jenkins | Credential store | `environment { X = credentials('id') }` |
| Bitbucket | Secured variable | Auto-injected into the step |

## Rules

- The secret lives in the store, never in the YAML. The config references it by env-var name only.
- Prefer a masked/secured store entry so the value is redacted in logs.
- Never template a config value with a secret (`image: $SECRET`, an inline URL with an embedded token) — masking covers logs, not the value you interpolate elsewhere, and Bitbucket forbids it outright.
- Buildkite forwards host env into a container only via `propagate-environment: true` or the plugin's `environment:` list — an exported var alone does not cross the container boundary.

## Anti-patterns

| Don't do this | Why it breaks |
|---|---|
| `script: your-command --token ghp_realvalue` | Secret is committed in plain YAML — leaked in the repo and logs |
| Bitbucket `image: $SECURED_VAR` | Secured variables cannot template the YAML; resolves to empty |
| Buildkite: exporting the var in a hook but no `propagate-environment` | The container process never sees it |
| CircleCI: expecting a context var without naming `context:` in the workflow | Context vars only attach to jobs whose workflow entry references the context |

## See also

- [run-docker-image.md](./run-docker-image.md) — Buildkite's `propagate-environment` and the container boundary
- [ci-context.md](./ci-context.md) — the non-secret built-in env vars the image also reads
