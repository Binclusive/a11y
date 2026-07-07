# The `action.yml` metadata file

Every custom action is defined by a metadata file — `action.yml` or `action.yaml`, in
YAML syntax. It declares the action's public interface (`name`, `description`, `inputs`,
`outputs`) and, in the required `runs:` block, **which of the three action types** the
action is and how to execute it. This file is the contract consumers see and the thing
`uses:` resolves to.

## Top-level fields

```yaml
name: 'My action'          # Required. Shown in the Actions tab and Marketplace.
author: 'some-owner'       # Optional.
description: 'What it does' # Required. One short line.

inputs:  { ... }           # Optional. Parameters the action accepts.
outputs: { ... }           # Optional. Values the action returns.

runs:    { ... }           # Required. Action type + how to run it.
branding: { ... }          # Optional. Marketplace icon + color.
```

## Inputs

```yaml
inputs:
  who-to-greet:
    description: 'Who to greet'   # Required.
    required: true                # Optional. Whether callers must supply it.
    default: 'World'              # Optional. Used when the caller omits it.
  old-flag:
    description: 'Legacy flag'
    deprecationMessage: 'Use who-to-greet instead.' # Logged as a warning when set.
```

Callers set inputs with `with:`:

```yaml
- uses: some-owner/greet@v1
  with:
    who-to-greet: 'Mona'
```

Each input is exposed to the action's code as an environment variable named
`INPUT_<UPPERCASE_NAME>` — the name is upper-cased and spaces become underscores, so
`who-to-greet` becomes `INPUT_WHO-TO-GREET`. See [docker-actions.md](./docker-actions.md)
for how a container reads these.

## Outputs

Output declaration differs by action type — this is a real decision surface.

**Docker and JavaScript actions** declare an output with only a description; the action's
code sets the value at runtime (by writing to `$GITHUB_OUTPUT`):

```yaml
outputs:
  result:
    description: 'The computed result'
```

**Composite actions** must additionally map the output to a step output with `value:`:

```yaml
outputs:
  result:
    description: 'The computed result'
    value: ${{ steps.compute.outputs.result }}
```

## The three action types (`runs.using`)

`runs.using` selects the type. This is the central choice; each type has its own `runs:`
shape.

### Docker container action

**When to use:** the action needs a specific OS, toolchain, or system packages — you
control the whole environment via a container. Linux runners only; slower to start.

```yaml
runs:
  using: 'docker'
  image: 'Dockerfile'          # local Dockerfile, or 'docker://image:tag'
  args:
    - ${{ inputs.who-to-greet }}
```

Full surface (image forms, `args`, `env`, entrypoints, the `INPUT_*` bridge, Dockerfile
constraints) lives in [docker-actions.md](./docker-actions.md).

### JavaScript action

**When to use:** the logic is JS/TS with no system dependencies — fastest to start and the
only type that runs on Linux, Windows, and macOS runners.

```yaml
runs:
  using: 'node20'   # or 'node24'
  main: 'dist/index.js'
  pre: 'dist/setup.js'    # optional, runs before main
  post: 'dist/cleanup.js' # optional, runs after main
```

### Composite action

**When to use:** bundle several workflow steps (`run` commands and other actions) into one
reusable step. No container, no separate JS runtime.

```yaml
runs:
  using: 'composite'
  steps:
    - run: echo "Hello ${{ inputs.who-to-greet }}"
      shell: bash
    - uses: actions/setup-node@v4
      with:
        node-version: '20'
```

## Branding

Optional; controls the Marketplace listing's appearance.

```yaml
branding:
  icon: 'award'   # a Feather icon name
  color: 'green'  # white|black|yellow|blue|green|orange|red|purple|gray-dark
```

## Decision guide

| Situation | `runs.using` | Read |
|---|---|---|
| Need custom OS / system packages / any language | `docker` | [docker-actions.md](./docker-actions.md) |
| Pure JS/TS, cross-platform, fast startup | `node20` / `node24` | this file |
| Compose existing steps + actions into one | `composite` | this file |

## Rules

- `name`, `description`, and `runs` are required; everything else is optional.
- The file is named `action.yml` or `action.yaml` and its location is what `uses:` resolves
  (see [uses-resolution.md](./uses-resolution.md)).
- Every input is surfaced to the action's process as `INPUT_<UPPERCASE_NAME>`.
- Composite outputs **must** carry `value:`; docker/JavaScript outputs must not — the code
  sets them at runtime.

## Anti-patterns

| Don't do this | Why it breaks |
|---|---|
| Composite output without `value:` | A composite action has no runtime process to set the output — the value must be mapped from a step output in the metadata. |
| Docker/JavaScript output **with** `value:` | Those types set outputs in code via `$GITHUB_OUTPUT`; `value:` in metadata is a composite-only field. |
| Omit `shell:` on a composite `run` step | `shell` is required for `run` steps in a composite action; the step will not run without it. |
| Expect a Docker action to run on a Windows/macOS runner | Docker container actions execute only on Linux runners. Use a JavaScript action for cross-platform. |

## See also

- [uses-resolution.md](./uses-resolution.md) — where this file must live for `uses:` to find it.
- [docker-actions.md](./docker-actions.md) — the full `runs.using: docker` surface.
- [publishing-and-pinning.md](./publishing-and-pinning.md) — releasing this metadata so consumers can pin it.
