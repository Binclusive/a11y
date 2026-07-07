# Docker container actions

A Docker container action runs the step inside a container you define — the way to ship an
action that needs a specific OS, system packages, or a non-JS toolchain. The `action.yml`
`runs:` block selects `docker`, points at an image, and wires inputs and arguments into the
container. Two things trip authors up: **how inputs reach the code inside the container**,
and **the Dockerfile constraints** GitHub imposes on the image.

## The `runs:` block

```yaml
runs:
  using: 'docker'
  image: 'Dockerfile'        # see "Image source" below
  env:
    SOME_VAR: 'value'        # env vars set in the container
  args:
    - ${{ inputs.who-to-greet }}
    - '--verbose'
  entrypoint: 'main.sh'      # optional: overrides the Dockerfile ENTRYPOINT
  pre-entrypoint: 'setup.sh'  # optional: runs in a separate container before entrypoint
  post-entrypoint: 'cleanup.sh' # optional: runs after entrypoint completes
```

## Image source — two approaches

### Build from a local Dockerfile

**When to use:** the action ships its own `Dockerfile` and you want GitHub to build it at
run time.

```yaml
runs:
  using: 'docker'
  image: 'Dockerfile'   # path to a Dockerfile in the action's directory
```

**Gotchas:**
- GitHub builds the image on every run unless cached — keep the Dockerfile lean.

### Reference a prebuilt image

**When to use:** the image is already published to a registry; skip the build.

```yaml
runs:
  using: 'docker'
  image: 'docker://ghcr.io/some-owner/some-image:1.2.3'
```

**Gotchas:**
- The `docker://` prefix is required to signal a prebuilt image rather than a Dockerfile path.
- Pin the image to an immutable tag or digest so runs are reproducible.

## How inputs reach the code inside the container

An action input named `who-to-greet` is exposed **inside the container** as the environment
variable `INPUT_WHO-TO-GREET` — upper-cased, spaces replaced with underscores. Two
independent channels feed a container action; know which you are using:

1. **Environment** — read `INPUT_<NAME>` (and anything under `runs.env`) directly:

   ```sh
   # entrypoint.sh
   echo "Hello $INPUT_WHO-TO-GREET"
   ```

2. **Arguments** — `runs.args` are passed to the entrypoint as positional arguments, in
   order. Use these when the containerized tool takes CLI flags:

   ```yaml
   args:
     - ${{ inputs.who-to-greet }}
   ```

   ```sh
   # entrypoint.sh — $1 is the first arg
   echo "Hello $1"
   ```

`runs.args` also **override** the Dockerfile's `CMD`.

## The default token

The `GITHUB_TOKEN` is not passed to a container automatically as an input — forward it
explicitly from the workflow and set the token's scopes with the `permissions:` key:

```yaml
# In the calling workflow
permissions:
  contents: read
steps:
  - uses: some-owner/some-action@v1
    env:
      GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

Inside the container the code reads `$GITHUB_TOKEN` from the environment.

## Dockerfile constraints

GitHub mounts and runs the container in a specific way; the Dockerfile must respect it.

```dockerfile
FROM alpine:3.20            # pin a version; avoid :latest
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]  # exec form
```

- **No `USER`.** The action must run as the default Docker user (root); otherwise it cannot
  access `GITHUB_WORKSPACE`.
- **No `WORKDIR`.** GitHub mounts `GITHUB_WORKSPACE` and sets it as the working directory —
  a `WORKDIR` fights that.
- **`FROM` must be first** and should pin a major version (`node:20`, not `node:latest`).
- **Prefer exec-form `ENTRYPOINT`** (`["/entrypoint.sh"]`). But note: with exec form the
  `args` do **not** run through a shell, so `$VAR` is not expanded in them. To expand
  variables, run a shell explicitly: `ENTRYPOINT ["sh", "-c", "echo $GITHUB_SHA"]`, or hand
  substitution off to the entrypoint script.

## Decision guide

| Situation | Approach |
|---|---|
| Action ships its own Dockerfile | `image: 'Dockerfile'` |
| Image already published to a registry | `image: 'docker://host/image:tag'` |
| Tool reads env vars | rely on `INPUT_*` + `runs.env` |
| Tool takes CLI flags | pass them via `runs.args` |
| Need `$VAR` expanded in args | shell-form or `ENTRYPOINT ["sh","-c",...]`, not exec form with raw args |

## Rules

- Container actions run **only on Linux runners**.
- Inputs are visible inside the container as `INPUT_<UPPERCASE_NAME>` env vars.
- `runs.args` are positional entrypoint arguments and override the Dockerfile `CMD`.
- The Dockerfile must not set `USER` or `WORKDIR`.

## Anti-patterns

| Don't do this | Why it breaks |
|---|---|
| `USER node` in the Dockerfile | The action loses access to `GITHUB_WORKSPACE`; it must run as root. |
| `WORKDIR /app` in the Dockerfile | GitHub sets the working directory to the mounted `GITHUB_WORKSPACE`; a `WORKDIR` breaks path assumptions. |
| Exec-form `ENTRYPOINT` with `args: ['$INPUT_X']` expecting expansion | Exec form does not invoke a shell, so `$INPUT_X` is passed literally. Use a shell or an entrypoint script. |
| Read an input as `$who-to-greet` inside the container | Inputs are exposed as `INPUT_WHO-TO-GREET`, not by their bare name. |

## See also

- [action-metadata.md](./action-metadata.md) — the surrounding `action.yml` and the other two action types.
- [uses-resolution.md](./uses-resolution.md) — how a consumer's `uses:` finds this action.
- [sarif-upload.md](./sarif-upload.md) — a common job for a container action: emit SARIF, then upload it.
