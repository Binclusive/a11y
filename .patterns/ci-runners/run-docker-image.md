# Run a published Docker image

Every CI system can execute a build step *inside* a container pulled from a
registry, but the keyword and the execution model differ. In some systems the
image *is* the job environment and your `script` runs inside it; in others the
job runs on the agent host and a plugin or block opts a step into a container.
This doc is the decision surface for "run the tool image as a step" — the entry
point every other concern builds on.

## Approaches

### GitLab CI/CD — `image:`

**When to use:** GitLab-hosted or self-managed GitLab Runner; the whole job runs in the image.

**Pattern:**

```yaml
scan:
  image:
    name: ghcr.io/OWNER/IMAGE:TAG
    entrypoint: [""]        # neutralize the image ENTRYPOINT so `script` is what runs
  script:
    - your-command --flag value
```

**Gotchas:**
- If the image declares an `ENTRYPOINT`, GitLab prepends it to your `script` shell and the job can hang or run the wrong thing. Override with `entrypoint: [""]`.
- `image:` as a bare string (`image: ghcr.io/OWNER/IMAGE:TAG`) is fine when no entrypoint override is needed.

### CircleCI — `docker` executor

**When to use:** CircleCI cloud/self-hosted; steps run in the **first** image listed.

**Pattern:**

```yaml
jobs:
  scan:
    docker:
      - image: ghcr.io/OWNER/IMAGE:TAG   # first image = primary; steps run here
    steps:
      - checkout
      - run: your-command --flag value
```

**Gotchas:**
- Only the **first** image in the `docker:` list is the primary execution container; additional entries are service containers (databases, etc.), not where `run` executes.
- The primary image must contain a shell for `run` steps to work.

### Buildkite — `docker#vX` plugin

**When to use:** self-hosted Buildkite agents; a command step runs on the agent host unless a plugin containers it.

**Pattern:**

```yaml
steps:
  - command: your-command --flag value
    plugins:
      - docker#v5.13.0:
          image: ghcr.io/OWNER/IMAGE:TAG
          always-pull: true
          propagate-environment: true    # forward agent env into the container
```

**Gotchas:**
- Without a container plugin the `command` runs directly on the agent host, not in the image.
- The plugin version pin (`docker#v5.13.0`) is load-bearing — plugins are resolved by ref.
- `propagate-environment: true` is what carries injected secrets/env into the container; see [secrets-and-env.md](./secrets-and-env.md).
- Multi-service (image + database) uses the `docker-compose` plugin instead of `docker`.

### Jenkins — `agent { docker { image } }`

**When to use:** Declarative Pipeline with the Docker Pipeline plugin.

**Pattern:**

```groovy
pipeline {
  agent { docker { image 'ghcr.io/OWNER/IMAGE:TAG' } }
  stages {
    stage('scan') {
      steps { sh 'your-command --flag value' }
    }
  }
}
```

**Gotchas:**
- The agent must have Docker available; the Docker Pipeline plugin runs the container on the node executing the stage.
- `agent` can be set per-`stage` instead of globally when only one stage needs the image.

### Bitbucket Pipelines — `image:` / `pipe:`

**When to use:** Bitbucket Cloud; `image:` sets the step (or pipeline) container.

**Pattern:**

```yaml
pipelines:
  default:
    - step:
        image: ghcr.io/OWNER/IMAGE:TAG
        script:
          - your-command --flag value
```

**Gotchas:**
- `image:` at pipeline top level sets the default for all steps; a step-level `image:` overrides it for that step.
- `pipe:` is the alternative for reusable, self-contained tool images (a pipe is a pre-packaged step); prefer `image:` when you just need the tool container as the environment.

## Decision guide

| System | Keyword | Where the step runs |
|---|---|---|
| GitLab | `image:` (+ `entrypoint: [""]`) | Inside the image (whole job) |
| CircleCI | `docker:` executor, first `image` | Inside the first image |
| Buildkite | `docker#vX` plugin | On the agent host → container via plugin |
| Jenkins | `agent { docker { image } }` | Container on the executing node |
| Bitbucket | `image:` (step or pipeline) | Inside the image |

## Rules

- A public registry image needs no auth block in any of these systems. A private image needs system-specific registry credentials (out of scope).
- The image must contain a shell for the `script`/`run`/`sh` steps to execute inside it.
- GitLab needs `entrypoint: [""]` whenever the image sets an `ENTRYPOINT` that would otherwise consume the `script`.
- Buildkite runs on the host by default — a container is opt-in per step via a plugin, unlike the others where the image is the environment.

## Anti-patterns

| Don't do this | Why it breaks |
|---|---|
| GitLab `image:` with an entrypoint image and no `entrypoint: [""]` | The declared ENTRYPOINT prepends to `script`; job hangs or runs the wrong process |
| CircleCI: expecting `run` to execute in the 2nd `docker:` image | Only the first image is primary; the rest are service containers |
| Buildkite `command:` with no `docker` plugin, expecting the image | The command runs on the agent host, not in the container |
| Buildkite plugin ref without a version (`docker:`) | Plugins resolve by ref; an unpinned/missing version fails resolution |

## See also

- [secrets-and-env.md](./secrets-and-env.md) — getting a token into the running container
- [ci-context.md](./ci-context.md) — the git/PR env vars the image can read once running
- [exit-codes.md](./exit-codes.md) — what the container's exit code does to the build
