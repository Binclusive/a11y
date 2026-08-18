# Binclusive accessibility — GitHub Action

**`Binclusive/a11y@v0`** — one thin [Docker container action](https://docs.github.com/en/actions/creating-actions/creating-a-docker-container-action)
that runs the Binclusive accessibility engine over your **changed source files** (React/TSX,
Shopify/Liquid, SwiftUI, Jetpack Compose, Unity), fails the build on blocking findings, and emits
[SARIF](https://sarifweb.azurewebsites.net/) for GitHub code scanning. Requires a Binclusive
`b8e_` API key — mint one in the dashboard and store it as a repo secret. No LLM key is needed;
the engine is deterministic.

It is a shell over the published GHCR image, pinned to an **image digest** — a given release runs
one exact set of image bytes, and changing them takes a merge here (see
[Versioning](#versioning)). **The engine source lives in the Binclusive monorepo**
(`packages/a11y`); this repo is only the published Action surface.

> **Looking for `Binclusive/a11y/action-url@v0`?** It was removed. URL scanning lives on as a local
> command — see [Scanning a live URL](#scanning-a-live-url).

## Static CI gate

**Before your first run**, mint a `b8e_` key in the dashboard and store it — plus your project id —
as repo secrets. `ci` authenticates before it scans.

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
          # Required. `ci` authenticates before it scans; without these it exits 7
          # (`Not authenticated`) and writes no SARIF.
          binclusive-api-key: ${{ secrets.BINCLUSIVE_API_KEY }}
          binclusive-project-id: ${{ secrets.BINCLUSIVE_PROJECT_ID }}

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
| `summary` | `false` | `true` emits the rollup digest (counts by level + top offending files) to the run's job summary page. Opt-in, default `false`. Needs no GitHub token and no permission grant — but it rides the same authenticated `ci` run as everything else. |
| `environment` | *(none — by design)* | Which deployment this run scanned: `pr` \| `staging` \| `production`. Leave unset on `on: pull_request`. **Required on any non-PR trigger** (push / schedule / workflow_dispatch) — see [Declaring the environment](#declaring-the-environment). |
| `binclusive-api-key` | *(none — required)* | **Required.** Binclusive `b8e_` apiKey — the run's identity. Authenticates the run and uploads findings. Absent → the action exits `7` (`Not authenticated`) without scanning. Store as a repo secret. |
| `binclusive-project-id` | *(none — required)* | **Required.** The project id findings belong to — selects which project; cannot be derived from the key. |
| `binclusive-api-url` | `""` | Optional. Override the Kontrol GraphQL endpoint (default `https://kontrol.binclusive.io/graphql`). Staging / self-host only. |

The run authenticates with your key and uploads its findings. Org is derived server-side from the
key — there is no `binclusive-org-id` input by design.

### The rollup summary

`summary: true` emits one digest — counts by level plus the top offending files — to the run's
summary page via `$GITHUB_STEP_SUMMARY`. No GitHub token, no permission grant, and no pull request
needed.
It renders on `push`, `schedule`, `workflow_dispatch`, and pull requests alike.

The summary itself does no dashboard round-trip — it is rendered from the run's own findings. It
still requires the authenticated `ci` run that produced them.

### Where the pull-request comment comes from

Earlier versions posted a sticky PR comment from inside the container, which is why this action
used to ask for a `github-token`. It no longer does, and no GitHub credential reaches the container
at all.

The comment is now written by Binclusive, from the findings a run uploads. Every run is
authenticated, so one thing has to be true for it to appear: the **Binclusive GitHub App** is
installed on the repository.

If the App is not installed the run says so on stderr and stays green — the scan, the exit gate,
the SARIF upload and the job summary are unaffected. They need no *GitHub* credential; they do
need your Binclusive key, like every `ci` run.

What this buys you: your workflow no longer grants `pull-requests: write`, and no *GitHub* token of
yours is handed to a container — only your Binclusive key, which is scoped to your org. Whoever
holds a key should perform the action rather than lending the key out.

### Declaring the environment

Every phoned-home run has to say **which deployment it scanned**, so the dashboard can separate a
pre-merge PR scan from your live production site. There are exactly two ways it gets stamped:

- **`on: pull_request`** — the run carries a PR ref, which is positive evidence it scanned a pull
  request. It stamps `pr` on its own. **Nothing to declare.**
- **Anything else** (`on: push`, a schedule, `workflow_dispatch`) — there is no PR ref, and a
  scheduled production scan, a staging pipeline and a developer's manual run are indistinguishable
  from inside the container. So you declare it, or the run **fails loudly** rather than guessing.

The input has **no default on purpose**. `production` is the dashboard's default filter, so
guessing it would silently drop a staging scan into your most-trusted view — a wrong answer that
looks right. A red job you fix once is the better failure.

One workflow that covers both triggers:

```yaml
on:
  pull_request:
  push:
    branches: [main]

# …

      - uses: Binclusive/a11y@v0
        with:
          environment: ${{ github.event_name == 'pull_request' && 'pr' || 'production' }}
          fail-on: warn
          binclusive-api-key: ${{ secrets.BINCLUSIVE_API_KEY }}
          binclusive-project-id: ${{ secrets.BINCLUSIVE_PROJECT_ID }}
```

Leaving `environment` out entirely is fine for a PR-only workflow — an unset input is forwarded as
an empty value, which the CLI treats exactly as unset. A **typo** is not: `prod` is rejected with a
loud error rather than quietly ignored, so a misdeclared run can never land under the wrong filter.

### Output

| Output | Description |
|--------|-------------|
| `sarif-file` | Path to the SARIF file. Feed it to `github/codeql-action/upload-sarif` (needs `security-events: write`). |

### Retire findings when a PR closes

Findings phoned home from a PR scan are **ephemeral** — scoped to that PR (Sentry-style). When the
PR closes (merged or abandoned) they should be retired. The close signal rides your own CI, because
only your repo ever learns that its PR closed.

This is **not** an Action. The scan is heavy — it needs the Binclusive Docker image, so it runs as
the `Binclusive/a11y@v0` Action. The close is the opposite: a lightweight
`ci close` CLI call that reads the closed PR's ref from the workflow event and POSTs it home. No
scan, no image — so it's a plain `npx @binclusive/cli` step, nothing to configure.

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

## Scanning a live URL

There is no Action for this, and that is deliberate. URL scanning is a **local** command:

```bash
b8e scan --url https://example.com
```

`scan` is the human lane — it runs against your `b8e login` session on your machine. `ci` is the
machine lane, and the Action above is its wrapper. A GitHub Action that ran `scan` was a machine
surface invoking the human command, which is why the `action-url` wrapper was removed rather than
credentialed; the local command itself is untouched and fully supported. See
[CHANGELOG.md](CHANGELOG.md).

## Versioning

`@v0` is a moving major tag that tracks the latest `v0.x` release of this shell. Pin to `@v0` to
ride releases, or to a commit SHA for a frozen pin.

Each release pins an exact **image digest**, not a floating `:0` tag. That matters for what you can
expect from a run: the engine inside the image changes only when a release of this Action changes
it. A new image published by the monorepo does not reach your workflow on its own — it arrives as a
repin PR here, which is reviewed, released as a normal `v0.x`, and revertable. Pinning to a commit
SHA freezes the image bytes exactly, because the digest is part of the commit.

### Releasing (automated)

Releases are **automatic** — there is no manual tagging step. When a change to the action shell
(`action.yml`) — or to `release.yml` itself — lands on `main`,
[`.github/workflows/release.yml`](.github/workflows/release.yml)
cuts the next `v0.x` tag and **moves the floating `@v0` major pin** to it, so consumers pinned to
`Binclusive/a11y@v0` ride the new release with no human in the loop. The bump follows Conventional
Commits: a `feat:` since the last tag is a minor bump, anything else is a patch. Each release also
cuts a matching GitHub Release.

Two deliberate non-goals:

- **No release-please.** The only release artifact here is a git tag plus the moving `@v0` pin —
  there is no package to publish and no per-release changelog to build, so release-please's
  release-PR machinery is overkill (and its bot release-PR is org-gated in this org). release-please
  stays a monorepo-wide platform decision, not a per-action-repo rider (monorepo#2553).
  [`CHANGELOG.md`](CHANGELOG.md) is not that file: it is hand-written and records **only** removals
  and breaking changes to the Action surface, which are the ones a consumer cannot discover from a
  green build.
- **No hand-written image repin.** The shell pins a digest, so a repin is a real change here — but
  not one anybody types. The monorepo's `release-image.yml` opens the repin PR after it has
  published, anonymously pulled and run-smoked a new image; merging it releases a new `v0.x`
  through the same path as any other shell change. If that automation is unavailable the pin simply
  stays where it is — consumers keep running the last reviewed image, which is the safe direction.

## Engine

The accessibility engine, its rule packs, the native SwiftUI/Compose collectors, and the corpus
regression matrix all live in the Binclusive monorepo under `packages/a11y`. Report engine
issues there; this repo tracks only the `action.yml` shell.
