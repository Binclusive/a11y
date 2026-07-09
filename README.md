# a11y-checker — review build

A local accessibility checker for React/TSX code, grounded in a real-world audit corpus. It finds accessibility bugs at the source — **including in the design-system components a normal linter is blind to** — and tells you how common each failure is across real audits, with the fix that worked.

> **It runs entirely on your machine. No network, no account, no upload — your code never leaves the laptop.** That's not a privacy policy, it's how it's built: there's nothing to upload. Point it at a private repo with zero hesitation.

This is a private review build. Clone it, point it at any React codebase (yours or ours), and see what it finds — no setup, no explanation needed.

> **New here? Start with the [Getting Started](docs/GETTING-STARTED.md) walkthrough.** Zero to your first fix — install, `init`, wire your editor, read a finding, clear it, gate CI.
>
> **Just want it on your PRs?** The [CI Quickstart](docs/QUICKSTART-CI.md) is the 5-minute path — copy [`examples/github-actions/a11y.yml`](examples/github-actions/a11y.yml), open a PR, read the findings. No account, no secret.

---

## See it in 30 seconds

On **shadcn/ui's own `taxonomy` app**, `eslint-plugin-jsx-a11y` (the linter everyone runs) passes the docs search box **clean** — while a11y-checker catches its unlabeled `<Input>`, ranks it (`22/26 orgs`), and hands you the fix.

![a11y-checker vs eslint on shadcn/ui taxonomy](demo/taxonomy.gif)

**▶ [Watch all five demos →](demo/README.md)** — the head-to-head above, a getting-started walkthrough on the cal.com monorepo, the `binclusive.json` config reference, the state of accessibility across 31 OSS repos, and the agentic self-fix loop. Each is a replayable [asciinema](https://asciinema.org) cast (`asciinema play demo/<name>.cast`), not just a GIF.

---

## Try it (≈3 minutes)

Requires **Node ≥ 20** and **pnpm** (or npm).

```bash
pnpm install                          # or: npm install
pnpm scan path/to/any/app/src         # any folder of .tsx files
```

That's the whole thing. It scans every `.tsx` under the folder and prints a coverage report + the findings. Run it on code you know — you'll be able to judge instantly whether each finding is real.

No clone handy? Point it at this repo's own test fixtures: `pnpm scan ./test/fixtures`.

> **No React source?** (A live site, an ASP.NET/Razor app, plain HTML.) The same checker can render a real page in a browser and audit the live DOM — `pnpm scan:url https://www.example.com`. See **[Auditing HTML & live pages (non-React)](#auditing-html--live-pages-non-react)** below.

> **Using your own design system?** (Almost everyone is.) A cold scan leaves most of your components in `declare` — *that's expected, not a failure.* To turn on its best trick (finding bugs *inside* your own components), it needs to know which of your components are buttons, inputs, etc. You don't write that by hand:
>
> ```bash
> pnpm a11y-checker init --suggest    # scaffolds the config for you
> ```
>
> It guesses a host for each of your design-system primitives, flags the uncertain ones with `⚠`, and leaves composites alone — so adoption is a **~2-minute review**, not hand-written config. Full on-ramp: **[WALKTHROUGH.md](WALKTHROUGH.md)** — read it before judging a cold run.

---

## What you'll see

```
a11y coverage:
  checked  70   — elements we inspected (findings come from here)
  trusted  60   — from a known-accessible design system — the library handles these
  declare  702  — unrecognized; declare in binclusive.json to inspect them

components/.../AddIntegrationModal.tsx
  AddIntegrationModal.tsx:276
    rule:   enforce/input-no-name  [block]  (call-site content check)
    wcag:   1.3.1, 3.3.2
    corpus: [VERY COMMON] SC 1.3.1 — 22/26 orgs
    fix:    Associate every form field with a <label> via id (not placeholder-only)...

91 finding(s)   VERY COMMON: 87  |  COMMON: 4
enforcement: 91 blocking · 0 warning
```

- **coverage is honest.** Most of a design-system app is *trusted* library components — nothing to flag there, and that's correct, not blindness. The number that matters is "did it find the real bugs," not "what % did it inspect."
- **each finding carries real-world weight** — its WCAG criterion, how widespread it is across our audits (`X/26 orgs`), and the representative fix.
- **`(call-site content check)`** marks findings that reach *trusted* components a normal linter skips. That's the recall win — "trusted" stops being false reassurance.

> **About the exit code:** `scan` exits non-zero when it finds *blocking* issues, so it can gate a CI build. If your run ends with `Command failed with exit code 1`, that's **not** an error — it means it found something. Read the report above it.

---

## What is this, in 30 seconds

Two passes + one corpus:

1. the normal structural lint (`eslint-plugin-jsx-a11y`) over a resolved component map, **plus**
2. a **content check at the call site** that catches bugs hiding inside "trusted" library components (an icon-only button with no name, an input with no label), **plus**
3. every finding **matched to a corpus** of real Binclusive audit failures — so it says not just *that* it's wrong, but *how common* it is in the wild and the fix that worked.

A generic linter can't do 2 or 3. The deeper story (and why the corpus is a moat) is in `docs/`.

There's also a **second producer**: a rendered-DOM collector that drives a real browser to a URL and runs axe-core against the live page — same corpus, same WCAG, same enforcement gate, no source required. That's the next section.

---

## Auditing HTML & live pages (non-React)

The scan above works on `.tsx` source. But not every page *has* React source on disk — a deployed site, an ASP.NET/Razor app, a plain HTML/Bootstrap/jQuery page. For those, point the checker at the **rendered page** instead of the source:

```bash
pnpm exec playwright install chromium   # one-time: the browser the render path drives
```

```bash
pnpm scan:url https://www.example.com   # a deployed site
pnpm scan:url http://localhost:5000     # your local dev server
pnpm scan:url ./wwwroot/index.html      # a local static .html file (bare path works)
```

`<target>` takes an `http(s)://` URL, a `file://` URL, or a **bare local path** (auto-converted to `file://`). Under the hood it renders the page in real Chromium (via Playwright), runs **axe-core** against the live DOM, then flows every finding through the *same* corpus / WCAG / enforcement machinery as the source scan — so a contrast bug on a live site comes back tiered and gated exactly like a missing label in your `.tsx`.

This is the source-less path — one command audits any live site, React or not.

- **Templates need a running server.** A server-side template (`.cshtml` Razor, `.erb`, etc.) is **not** valid standalone HTML — it's `@`-directives, loops, interpolation — so `file://` can't render it. Point `check-url` at the **running app** (`localhost`) for templates. Only plain `.html` files render directly via `file://`.
- **It catches what static analysis can't.** A real browser render surfaces categories the `.tsx` scan and even headless DOMs (jsdom) are blind to — notably **color-contrast (WCAG 1.4.3)**, computed ARIA roles, and layout-dependent rules.
- **Honest edge:** the seed corpus snapshot currently covers ~10 success criteria and does **not** yet include some SCs this path surfaces (e.g. 1.4.3 contrast, 1.4.1, 2.4.4). Those findings still appear — the render catches them regardless — but they roll up as tier `UNKNOWN` (no corpus fix text) until the corpus is extended.

The full walkthrough — install once, read the output, the `(rendered-DOM / axe)` provenance tag — is in **`docs/AUDIT-URL.md`**.

---

## Use it in CI (GitHub Action)

Drop the Action into a pull-request workflow. On every PR it runs the Binclusive
accessibility engine on the **changed files** (diff against the PR base), **gates
the PR**, and writes a SARIF file. Feed that file to GitHub's own `upload-sarif`
step and the findings render as **native code-scanning annotations** on the PR
diff — the reference UX, à la CodeQL.

The action is a **thin `docker://` shell** over the engine image the Binclusive
monorepo builds and publishes to GHCR — it makes **zero GitHub API calls** and
needs **no token**. It is the **deterministic free lane**; BYOK / AI enrichment
is the separate paid lane and is not wired here.

```yaml
name: a11y
on: pull_request

permissions:
  contents: read
  security-events: write # upload SARIF as code-scanning annotations

jobs:
  a11y:
    runs-on: ubuntu-latest
    steps:
      # fetch-depth: 0 — the diff scan needs base history; a shallow clone finds 0 changed files
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - id: a11y
        uses: Binclusive/a11y@v2
        with:
          base: ${{ github.event.pull_request.base.ref }}  # diff against the PR base
          # fail-on: block   # block|warn — default block (a gating finding fails the build)
      - if: always()  # upload SARIF regardless of the gate outcome
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: ${{ steps.a11y.outputs.sarif-file }}
```

Inputs:

| Input | Set it to | Default | Effect |
|---|---|---|---|
| `base` | a git ref (e.g. the PR base) | `""` (whole checkout) | Diff against this ref; only changed files are scanned. Empty scans the whole checkout. |
| `fail-on` | `block` \| `warn` | `block` | The enforcement level that fails the build. `block` fails on a gating finding; `warn` never fails. |

Annotations land on the exact changed file + line. The SARIF file exists only to
render on **your** GitHub — it carries file/line for local annotation and is
never sent anywhere else.

> **Pin for supply-chain safety.** The example pins the moving major tag `@v2`,
> which tracks the latest v2 release. For production, pin to a commit SHA — `uses:
> Binclusive/a11y@<sha>  # v2` — so a moved tag can't silently change what runs in
> your CI. Dependabot (`github-actions` ecosystem) will bump the pin for you.

## Use it on GitLab (native MR-note reporter)

On GitLab, the engine has a **native reporter adapter** (like the GitHub one): it
posts the findings as a **merge-request note** instead of only emitting an artifact.
Drop the ready-made [`examples/ci/gitlab/.gitlab-ci.yml`](examples/ci/gitlab/.gitlab-ci.yml)
at your repo root — it runs the image over the `.tsx` changed in each MR and selects
the GitLab reporter.

Enable it with two things:

1. **Select the adapter** — set `A11Y_PLATFORM=gitlab` (the config already does).
   The MR is identified from GitLab's own `CI_PROJECT_ID` + `CI_MERGE_REQUEST_IID`,
   with `CI_API_V4_URL` as the REST base — all provided in a `merge_request` pipeline.
2. **Provide a token with `api` scope** — store a **project or personal access
   token** as a **masked** CI/CD variable named `A11Y_GITLAB_TOKEN`
   (*Settings → CI/CD → Variables*). It is preferred over the auto-injected
   `CI_JOB_TOKEN`, whose narrower API surface cannot reliably create MR notes;
   `CI_JOB_TOKEN` is used as a zero-config fallback when no `A11Y_GITLAB_TOKEN` is set.

**Opt-in, no-op by default.** With **no MR context** (a plain branch pipeline) or
**no token**, the reporter posts nothing — the scan still runs, the artifacts still
emit, and the job still exits 0 (advisory). Posting is best-effort: a failed GitLab
API call is logged and swallowed, never failing the pipeline. Re-runs update the same
MR note in place rather than adding a new one per push. Opt into a failing job with
`FAIL_ON` / `MAX_VIOLATIONS` (see the config).

## Use it on Buildkite (native annotation reporter)

On Buildkite, the engine has a **native reporter adapter** (like the GitHub and
GitLab ones): it publishes the findings as a **build annotation** — grouped, with
each finding's `file:line` and a WCAG-criteria summary — instead of only emitting an
artifact. Drop the ready-made [`examples/ci/buildkite/pipeline.yml`](examples/ci/buildkite/pipeline.yml)
into your pipeline — it runs the image over the `.tsx` changed in each PR and selects
the Buildkite reporter.

Enable it with two things:

1. **Select the adapter** — set `A11Y_PLATFORM=buildkite` (the config already does).
   The PR is identified from Buildkite's own `BUILDKITE_PULL_REQUEST`; a non-PR build
   sets it to the string `"false"`, in which case the adapter no-ops.
2. **Give the container the agent** — the reporter shells out to `buildkite-agent
   annotate` from *inside* the engine container, so the `buildkite-agent` binary and
   its access token must be mounted in. The docker plugin does this via
   `mount-buildkite-agent: true` (its default; the config pins it explicitly). No API
   token to manage — `buildkite-agent` authenticates with the agent's own token.

**Opt-in, no-op by default.** With **no PR context** (`BUILDKITE_PULL_REQUEST` absent
or `"false"`), the reporter posts nothing — the scan still runs, the artifacts still
emit, and the step still exits 0 (advisory). Posting is best-effort: a non-zero
`buildkite-agent` exit or a missing binary is logged and swallowed, never failing the
build. Re-runs update the **same annotation in place** (a stable `--context=a11y`)
rather than appending a new one per push. Opt into a failing step with `FAIL_ON` /
`MAX_VIOLATIONS` (see the config).

## Use it on any other CI/CD (generic `--ci` mode)

Not on GitHub or GitLab? The engine runs the same scan on **CircleCI, Jenkins, Drone,
or a bare `docker run`** with no native adapter — just run the image and emit a standard
artifact:

```sh
docker run --rm -v "$PWD:/workspace" -w /workspace -e A11Y_PLATFORM=null \
  ghcr.io/binclusive/a11y:latest \
  check /workspace/src --ci --format sarif > a11y.sarif
```

`--format sarif` emits a valid **SARIF 2.1.0** log (or `--format json` for the raw
report); `--ci` makes the **non-blocking exit-0 a first-class engine mode** — the
run always exits 0 even with blocking findings, so any platform can consume the
artifact without failing the build. With no PR/MR context nothing is posted and the
artifacts still emit. Opt into a failing build with `--fail-on` / `--max-violations`.

Copy-paste CircleCI / Jenkins / Drone snippets, and the config-scaffold pattern that
native platform adapters build on, are in **[`docs/CI.md`](docs/CI.md)**.

---

## Dig deeper

| If you want… | Open / read |
|---|---|
| **Adopt it with your own design system** | **`WALKTHROUGH.md`** |
| **Run it on any CI/CD (CircleCI / Jenkins / Drone / generic)** | **`docs/CI.md`** |
| **Ready-made configs for GitLab / CircleCI / Buildkite / Jenkins / Bitbucket** | **[`examples/ci/`](examples/ci/)** |
| **Audit a live URL or HTML page (non-React)** | **`docs/AUDIT-URL.md`** |
| The pitch + the moat, with numbers | `docs/decks/numbers.html` |
| Real findings on real OSS projects | `docs/decks/showcase.html` |
| How the machine works, conceptually | `docs/decks/engineering.html` |
| How it's built — the craft | `docs/decks/engineering-deep.html` |
| **The code map — which file does what** | `docs/ARCHITECTURE.md` |
| **The questions you're about to ask** | `FAQ.md` |

The decks are self-contained HTML — open in a browser, arrow keys to navigate, `O` for contents.

---

## Kick the tires

```bash
pnpm test        # all green
pnpm typecheck   # clean
```

Editor surfaces (an MCP server + a Claude Code auto-whisper hook that fixes a11y as the AI writes) are in `plugin/` — `pnpm mcp` starts the local MCP server. The CLI above is the fastest way to feel what it does.

---

*Structure note: this is the `a11y-checker` package extracted to run standalone. Where `docs/ARCHITECTURE.md` says `packages/a11y-checker/src/…`, in this repo it's just `src/…`.*
