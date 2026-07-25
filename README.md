# Binclusive accessibility — GitHub Action

Two thin [Docker container actions](https://docs.github.com/en/actions/creating-actions/creating-a-docker-container-action)
that run the Binclusive accessibility engine in CI and emit [SARIF](https://sarifweb.azurewebsites.net/)
for GitHub code scanning. No account, no token, no LLM key — the deterministic free lane needs none.

- **`Binclusive/a11y@v0`** — the **static** CI gate. Runs the engine over your changed files
  (React/TSX, Shopify/Liquid, SwiftUI, Jetpack Compose, Unity), fails the build on blocking
  findings, writes SARIF.
- **`Binclusive/a11y/action-url@v0`** — the **URL** scan. Renders a live URL in real Chromium
  (the `:0-browser` image) and audits the rendered DOM.

Both are pinned-image shells over the published GHCR images
(`ghcr.io/binclusive/binclusive:0` and `:0-browser`). **The engine source lives in the Binclusive
monorepo** (`packages/a11y`); this repo is only the published Action surface.

## Static CI gate

```yaml
name: accessibility
on: pull_request
permissions:
  contents: read
  security-events: write   # required to upload SARIF to code scanning
jobs:
  a11y:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0    # need history so the action can diff against the base

      - id: scan
        uses: Binclusive/a11y@v0
        with:
          base: ${{ github.event.pull_request.base.sha }}
          fail-on: block     # block | warn — the level that fails the build

      - uses: github/codeql-action/upload-sarif@v3
        if: always()         # upload findings even when the gate fails the build
        with:
          sarif_file: ${{ steps.scan.outputs.sarif-file }}
```

### Inputs

| Input | Default | Description |
|-------|---------|-------------|
| `base` | `""` | Git ref to diff against (e.g. the PR base SHA). Empty scans the whole checkout. |
| `fail-on` | `block` | `block` \| `warn` — the enforcement level that fails the build. |
| `b8e-token` | `""` | Optional Binclusive `b8e_` apiKey. Present → findings phone home to the dashboard; absent → fully local (exit 0, never an error). Store as a repo secret. |
| `b8e-project-id` | `""` | Optional. The project id findings belong to. Required alongside `b8e-token` — selects which project; cannot be derived from the token. |
| `b8e-api-url` | `""` | Optional. Override the Kontrol GraphQL endpoint (default `https://kontrol.binclusive.io/graphql`). Staging / self-host only. |

Phone-home is opt-in and local-first: with no `b8e-token` the gate behaves exactly as before. Org
is derived server-side from the token — there is no `b8e-org-id` input by design.

### Output

| Output | Description |
|--------|-------------|
| `sarif-file` | Path to the SARIF file. Feed it to `github/codeql-action/upload-sarif` (needs `security-events: write`). |

### Retire findings when a PR closes

Findings phoned home from a PR scan are **ephemeral** — scoped to that PR (Sentry-style). When the
PR closes (merged or abandoned) they should be retired. The close signal rides your own CI, because
only your repo ever learns that its PR closed.

This is **not** an Action. The scan is heavy — it needs the Binclusive Docker image and a real
browser, so it runs as the `Binclusive/a11y@v0` Action. The close is the opposite: a lightweight
`ci close` CLI call that reads the closed PR's ref from the workflow event and POSTs it home. No
scan, no browser, no image — so it's a plain `npx @binclusive/cli` step, nothing to configure.

Add this job (its own workflow file, or a `closed`-typed trigger alongside an existing one):

```yaml
# Clear a PR's accessibility findings when it closes — a plain CLI step, no Action needed.
on:
  pull_request:
    types: [closed]
jobs:
  retire-findings:
    runs-on: ubuntu-latest
    steps:
      - run: npx @binclusive/cli@0 ci close
        env:
          BINCLUSIVE_API_KEY: ${{ secrets.BINCLUSIVE_API_KEY }}
          BINCLUSIVE_PROJECT_ID: ${{ secrets.BINCLUSIVE_PROJECT_ID }}
```

`@binclusive/cli@0` pins the CLI to its stable v0 major, matching the `@v0` convention used for the
Action. The two same secrets the scan uses (`BINCLUSIVE_API_KEY` + `BINCLUSIVE_PROJECT_ID`) are all
it needs — `ci close` reads them straight off the environment.

This step is for **prompt** cleanup. Findings also auto-expire via a server-side TTL, so a PR whose
close event you never wire up still gets swept eventually — the `ci close` step just retires them
immediately instead of waiting out the TTL.

## URL scan

```yaml
      - id: scan
        uses: Binclusive/a11y/action-url@v0
        with:
          url: https://example.com
          timeout-ms: "30000"   # optional; engine default 30000

      - uses: github/codeql-action/upload-sarif@v3
        if: always()
        with:
          sarif_file: ${{ steps.scan.outputs.sarif-file }}
```

| Input | Default | Description |
|-------|---------|-------------|
| `url` | *(required)* | The URL to render and scan. |
| `timeout-ms` | `""` | Max ms to wait for navigation + load. Engine default 30000. |

## Versioning

`@v0` is a moving major tag that tracks the latest `:0` (and `:0-browser`) image. Pin to `@v0`
for automatic patch/minor image updates, or to a commit SHA for a frozen pin.

### Releasing (automated)

Releases are **automatic** — there is no manual tagging step. When a change to either action shell
(`action.yml` or `action-url/**`) lands on `main`, [`.github/workflows/release.yml`](.github/workflows/release.yml)
cuts the next `v0.x` tag and **moves the floating `@v0` major pin** to it, so consumers pinned to
`Binclusive/a11y@v0` ride the new release with no human in the loop. The bump follows Conventional
Commits: a `feat:` since the last tag is a minor bump, anything else is a patch. Each release also
cuts a matching GitHub Release.

Two deliberate non-goals:

- **No release-please.** The only release artifact here is a git tag plus the moving `@v0` pin —
  there is no package to publish and no changelog to build, so release-please's release-PR machinery
  is overkill (and its bot release-PR is org-gated in this org). release-please stays a monorepo-wide
  platform decision, not a per-action-repo rider (monorepo#2553).
- **No image repin.** Both shells pin a **moving** image tag (`:0` / `:0-browser`) that the monorepo's
  `release-image.yml` re-points to the latest digest on every prod push. The action rides new images
  automatically, so there is nothing to repin in this repo (the #2553 moving-tag approach).

## Engine

The accessibility engine, its rule packs, the native SwiftUI/Compose collectors, and the corpus
regression matrix all live in the Binclusive monorepo under `packages/a11y`. Report engine
issues there; this repo tracks only the two `action.yml` shells.
