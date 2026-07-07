# Quickstart — the a11y checker in CI (5 minutes)

The fewest steps from nothing to accessibility findings on your next pull
request. This is the **CI-Action path** — a GitHub Action you drop into a
workflow. (For the local CLI / Claude Code plugin path, see
[`GETTING-STARTED.md`](GETTING-STARTED.md) instead.)

No account, no secret, no config. The deterministic floor runs on the workflow
token you already have.

## 1. Add the workflow

Copy [`examples/github-actions/a11y.yml`](../examples/github-actions/a11y.yml)
into your repository as `.github/workflows/a11y.yml`:

```yaml
name: a11y
on: pull_request

permissions:
  contents: read
  pull-requests: write   # inline review comments + rollup comment
  security-events: write # upload SARIF as code-scanning annotations

jobs:
  a11y:
    runs-on: ubuntu-latest
    steps:
      # fetch-depth: 0 — the a11y diff scan needs base history; a shallow clone finds 0 changed files (a11y#198)
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - id: a11y
        uses: Binclusive/a11y@v0.1.3 # x-release-please-version
      - if: always() # advisory gate exits 0; upload regardless of findings
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: ${{ steps.a11y.outputs.sarif-file }}
```

That's the whole thing. `github-token` defaults to the workflow token, so there
is **no `with:` block and no secret to set** for the floor.

## 2. Open a PR that changes a `.tsx` file

The Action scans the **changed** `.tsx` files on the PR — the diff, not the whole
tree. Edit a component (or open a PR against a branch that does) and push.

## 3. Read the findings — three surfaces, all on your GitHub

| Where | What you see |
|---|---|
| **Inline PR comments** | One review comment per finding, anchored on the exact changed line. |
| **Rollup comment** | A single summary comment on the PR — counts, tiers, the headline. |
| **Code-scanning annotations** | The SARIF upload renders findings as native annotations on the diff (the CodeQL UX), each tagged `deterministic` or `agent`. |

The scan is **advisory by default: it exits 0** and never blocks the merge. Every
finding leads with the harmed user and the human consequence — the rule id and
WCAG success criterion follow as secondary lines.

> The SARIF file carries file/line only to render on **your** GitHub. It is never
> sent to the Binclusive dashboard.

That is the full loop: add the workflow → open a PR → see findings.

---

## Turn on more (all optional)

Each lane below is independent — add none, one, or several. Absent always means
"lane off", never an error; the floor keeps running. The wired-up reference is
[`examples/github-actions/a11y-advanced.yml`](../examples/github-actions/a11y-advanced.yml).

### AI enrichment (bring your own key)

Supply your **own** LLM provider key as a repo secret to add the AI lane on top
of the deterministic floor. Provider-agnostic — no provider is baked into the
Action. Anthropic and OpenAI are shipped.

```yaml
      - id: a11y
        uses: Binclusive/a11y@v0.1.3 # x-release-please-version
        with:
          llm-api-key:  ${{ secrets.LLM_API_KEY }}  # your BYOK model key
          llm-provider: anthropic                    # default: anthropic
          llm-model:    claude-haiku-4-5-20251001    # default model
```

`llm-provider` / `llm-model` only matter alongside `llm-api-key`; absent, the
engine defaults to Anthropic `claude-haiku-4-5-20251001`. Your key never touches
Binclusive auth — it stays on the runner.

### Block the merge (default off)

Set either input and the check **fails** on the threshold. Both stay advisory
(exit 0) when unset; comments and SARIF post either way.

| Input | Set it to | Fails when |
|---|---|---|
| `fail-on` | `critical` \| `major` \| `minor` | any finding is at or above that severity |
| `max-violations` | an integer `N` | the total finding count exceeds `N` |

### Branded PR comments

Install the Binclusive GitHub App and pass its id + private key to post comments
under the branded identity instead of `github-actions[bot]`. Pure identity swap;
falls back to the workflow token (and still exits 0) if unconfigured.

### Send findings to the Binclusive dashboard

Mint a `b8e-token` in the dashboard and pass it (with your org/project ids) to
phone metadata-only findings home. Absent → the scan stays fully local.

---

## Auditing non-React or live pages

The Action above scans `.tsx` **source**. For pages with no React source on disk
— a deployed site, a Razor/ASP.NET app, plain HTML — use the rendered-DOM path,
which drives a real browser (Playwright + axe-core). Today that path ships in the
**CLI** (`scan:url` / `check-url`) — see [`AUDIT-URL.md`](AUDIT-URL.md).

> **A dedicated URL-scan CI Action (`Binclusive/a11y/action-url@v<version>`,
> browser image) is in progress (#2336) but not yet in a released tag** — pin a
> URL scan into CI only once it ships. Until then, drive the rendered-DOM scan
> from the CLI in a `run:` step, or use the source scan above.

## Running on other CI platforms

Not on GitHub? The same engine runs on CircleCI, Jenkins, Drone, or a bare
`docker run` via the generic `--ci` mode — see [`CI.md`](CI.md).

## Pinning for supply-chain safety

These examples pin to the released tag `v0.1.3` <!-- x-release-please-version -->. For production, pin to a commit
SHA — `uses: Binclusive/a11y@<sha>  # v0.1.3` <!-- x-release-please-version --> — so a moved tag can't change what
runs in your CI. Dependabot (`github-actions` ecosystem) will bump the pin for
you.
