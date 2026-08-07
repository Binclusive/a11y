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
| `summary` | `false` | `true` emits the rollup digest (counts by level + top offending files) to the run's job summary, and on a PR run also as one sticky comment rewritten in place each run. Opt-in — the comment half needs `pull-requests: write`; see [The rollup summary](#the-rollup-summary). |
| `github-token` | `${{ github.token }}` | The token the PR-comment surfaces authenticate with. Defaults to the job's own token — nothing to set. Override only to post as a different actor; for `binclusive[bot]` use `binclusive-app-*` instead. |
| `environment` | *(none — by design)* | Which deployment this run scanned: `pr` \| `staging` \| `production`. Leave unset on `on: pull_request`. **Required on any non-PR trigger that phones home** — see [Declaring the environment](#declaring-the-environment). |
| `binclusive-api-key` | `""` | Optional Binclusive `b8e_` apiKey. Present → findings phone home to the dashboard; absent → fully local (exit 0, never an error). Store as a repo secret. |
| `binclusive-project-id` | `""` | Optional. The project id findings belong to. Required alongside `binclusive-api-key` — selects which project; cannot be derived from the key. |
| `binclusive-api-url` | `""` | Optional. Override the Kontrol GraphQL endpoint (default `https://kontrol.binclusive.io/graphql`). Staging / self-host only. |
| `binclusive-app-id` | `""` | Optional. Binclusive GitHub App id — set with the private key to attribute phone-home writes to `binclusive[bot]` instead of the default workflow bot. |
| `binclusive-app-private-key` | `""` | Optional. The App private key (PEM). Secret material — store as a repo secret. |
| `binclusive-app-installation-id` | `""` | Optional. The App installation id for this repo. Usually unnecessary — discovered from the repo when absent. |

Phone-home is opt-in and local-first: with no `binclusive-api-key` the gate behaves exactly as
before. Org is derived server-side from the key — there is no `binclusive-org-id` input by design.

### The rollup summary

`summary: true` renders one digest — counts by level plus the top offending files — to **two**
surfaces, not one:

| Surface | Where it lands | Needs a token? | Needs a PR? |
|---------|----------------|----------------|-------------|
| **Job summary** | The run's own summary page, via `$GITHUB_STEP_SUMMARY` | No | No |
| **Sticky PR comment** | One comment on the PR, rewritten in place every run | Yes | Yes |

The job-summary half is the one that always works: it needs no `pull-requests:` grant, no token,
and no pull request, so it also renders on `push`, `schedule` and `workflow_dispatch` runs. The
comment half is the reviewer-facing one — it upserts a **single** comment and rewrites it on every
push instead of stacking a new one per run.

Both are **stateless**: no api key, no project id, no dashboard round-trip. That matters because the
other PR surface, the inline per-line review comments, is verdict-driven — no `binclusive-api-key`
means no ingest, which means no verdicts, which means that lane skips entirely. So on a local-first
setup (no account, no token) the summary is the **only** PR comment surface there is. The two are
not redundant even when both run: the summary is one index comment beside N per-line comments, not
a second copy of the findings.

The comment half authenticates with the `github-token` input, which defaults to the job's own
`${{ github.token }}` — there is nothing to wire up. What that token may *do* is decided by your
job's `permissions:` block:

```yaml
permissions:
  contents: read
  security-events: write   # SARIF upload
  pull-requests: write     # required by `summary: true` — the comment write

# …

      - uses: Binclusive/a11y@v0
        with:
          base: ${{ github.event.pull_request.base.sha }}
          summary: "true"
```

It stays **default-off on purpose.** The comment write fails **loudly**: on a job whose
`pull-requests:` scope is missing or read-only, GitHub refuses the write, the CLI raises
`PrCommentError` rather than logging-and-continuing, and the step exits `2` — the crash pole,
deliberately distinct from the findings gate's exit `1`. The run goes **red**; it does not silently
omit the comment. (The job summary still renders — it needed no token to begin with.)

Be precise about what those distinct codes buy you: they are **distinguishable by a consumer who
inspects them**, not unswallowable. `continue-on-error: true` greens the job on **any** non-zero
exit — it never reads the number. So if you set it to tolerate findings, it also greens a run whose
`pull-requests: write` was denied, which is exactly the silent skip this feature exists to end. If
you need both, drop `continue-on-error` and branch on the code yourself (`exit 1` → findings,
`exit 2` → the comment write failed).

A red build is the right answer for a surface you asked for and cannot get, but only if you asked.
So enabling it and granting `pull-requests: write` is one deliberate decision, never a default that
turns a working workflow red on an image bump.

Two consequences worth knowing before you turn it on:

- **Pull requests from forks.** GitHub downgrades every write permission to read for a
  `pull_request` event from a fork ([workflow syntax →
  `permissions`](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#permissions)),
  so the comment write is refused and the run reds — by design, but on traffic you do not control.
  Leave `summary` off on fork-facing workflows, or gate it on whether the head repo is *this* repo:
  `summary: ${{ github.event.pull_request.head.repo.full_name != github.repository && 'false' || 'true' }}`.
  Test the repo, not the `head.repo.fork` flag: that flag is true whenever the head repo is itself a
  fork, so it also switches the summary off for same-repo pull requests inside your own downstream
  fork — where the write would have succeeded.
- **The value is matched exactly.** `"true"` turns it on; `"false"` and `""` (an explicitly blank
  input) turn it off. Anything else — `yes`, `True`, a typo — is **refused** with exit `4`, the
  "you invoked me wrong" code, rather than being quietly read as off.

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
