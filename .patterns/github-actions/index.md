# GitHub Actions authoring patterns

How to **author a GitHub Action** — the `action.yml` metadata contract, the container
runtime, how a consumer's `uses:` resolves to your action, how you release it for pinning,
and how an analysis action uploads SARIF to code scanning. These patterns make agents write
correct action definitions without guessing where metadata must live, how inputs reach the
code, or which reference form addresses which file.

Source of truth: GitHub's own Actions documentation (metadata syntax, workflow syntax,
creating/publishing actions, code scanning). These docs teach the platform itself — every
example is a generic, docs-derived illustration.

Scope: **authoring** a custom action (Docker / composite / JavaScript, with Docker covered
deepest) and the consume/release/upload surfaces around it. Excluded: general workflow
authoring (triggers, jobs, matrices), reusable workflows, and the CodeQL analysis engine
itself — only the SARIF **upload** step is covered.

## Index

| Doc | Concern | Read when |
|---|---|---|
| [uses-resolution.md](./uses-resolution.md) | How `uses:` resolves a reference to an `action.yml` (root vs subdir vs local vs docker) | An action "can't be found" or you're choosing where metadata lives — the root-vs-subdir rule |
| [action-metadata.md](./action-metadata.md) | The `action.yml` schema: `name`/`inputs`/`outputs`/`runs` and the three action types | Writing or editing any `action.yml` |
| [docker-actions.md](./docker-actions.md) | `runs.using: docker` — image source, `args`/`env`, `INPUT_*`, Dockerfile constraints | Authoring a container action or debugging inputs inside the container |
| [publishing-and-pinning.md](./publishing-and-pinning.md) | Releasing an action: semver tags, moving major aliases, SHA vs tag, Marketplace | Cutting a release or deciding how consumers pin |
| [sarif-upload.md](./sarif-upload.md) | Uploading SARIF via `github/codeql-action/upload-sarif` + required permissions | An action emits SARIF and must surface it in code scanning |

## Shared conventions

- All examples are generic illustrations (`some-owner/action@v1`, a generic `action.yml`) —
  never a specific repository's real action.
- Action metadata is always the file `action.yml` (preferred) or `action.yaml`.
- Every action input is exposed to the action's process as `INPUT_<UPPERCASE_NAME>`.
- Docker container actions run only on Linux runners; JavaScript actions run cross-platform.
