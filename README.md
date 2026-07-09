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

### Output

| Output | Description |
|--------|-------------|
| `sarif-file` | Path to the SARIF file. Feed it to `github/codeql-action/upload-sarif` (needs `security-events: write`). |

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

## Engine

The accessibility engine, its rule packs, the native SwiftUI/Compose collectors, and the corpus
regression matrix all live in the Binclusive monorepo under `packages/a11y`. Report engine
issues there; this repo tracks only the two `action.yml` shells.
