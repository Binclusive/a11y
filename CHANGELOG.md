# Changelog

This file is **not** a per-release log — `release.yml` tags every `v0.x` automatically and `git log`
is the complete history. It records only **removals and breaking changes to the Action surface**:
the changes a consumer cannot discover from a green build, and the ones a public-code search cannot
warn private repositories about.

## Removed: the keyless local lane — `ci` now requires an API key — 2026-08-17

**What.** `binclusive ci` authenticates before it scans. A run with no `binclusive-api-key` exits
`7` (`Not authenticated`) **before the scanner starts**, writes no SARIF, and produces no summary.
The key is now the run's identity, not just the ingestion bearer.

**This is deliberate.** It is not a regression to be worked around — there is no flag that restores
a credential-free scan. `--no-upload` does not: it suppresses the upload, not the identity check.

**Who this breaks.** Any workflow that omits `binclusive-api-key`. Until now that was the
documented default — the README's quickstart passed no key and this repo advertised a "free lane".
Both were accurate when written and are now withdrawn.

**How it looks when it breaks, which is the reason this entry exists.** The container writes SARIF
to stdout, so a refusal leaves `results.sarif` **empty**. Your `upload-sarif` step then fails with:

```
Invalid SARIF. Unexpected end of JSON input
```

That error names the wrong step, the wrong tool and the wrong cause. The real cause is on stderr of
the step above it: `Not authenticated. Run: b8e auth login`. Read that line first.

**The fix.** Mint a `b8e_` key in the dashboard, store it and your project id as repo secrets, and
pass both:

```yaml
- uses: Binclusive/a11y@v0
  with:
    base: ${{ github.event.pull_request.base.sha }}
    binclusive-api-key: ${{ secrets.BINCLUSIVE_API_KEY }}
    binclusive-project-id: ${{ secrets.BINCLUSIVE_PROJECT_ID }}
```

**When it reaches you.** With the image repin in #353. Runs on `sha256:fc3365…` and earlier predate
the gate and are unaffected; every release from the repin forward enforces it.

**One more thing 0.21.0 changed, so the warning is not a mystery.** `--fail-on` is now a *severity*;
the enforcement axis moved to `--enforce`. This Action's `fail-on` input still works — it maps
through a compatibility shim — but the shim prints a deprecation notice to **stderr** on every run.
That notice is expected and does not affect the gate, the exit code, or the SARIF on stdout.

## Removed: automatic image updates on `@v0` — 2026-08-10

**What.** `action.yml` now pins an image **digest** instead of the moving `ghcr.io/binclusive/binclusive:0`
tag. `@v0` no longer picks up a newly published image on its own.

**Nothing breaks, and nothing you run changes.** The pinned digest is exactly what `:0` resolved to
when this landed, so the first run after it executes the same bytes as the last run before it.

**What changes is when the image can change.** Previously any prod push in the Binclusive monorepo
re-pointed `:0`, and every workflow picked the new image up on its next run — no merge, no notice.
Now a new image arrives as a repin PR in this repo, reviewed and released as a normal `v0.x`, and
revertable. This is listed here because it is a **withdrawn guarantee**: the README used to offer
"automatic patch/minor image updates" on `@v0`, and a green build will never tell you that stopped.

**If you want the old behaviour,** reference the image directly — `container: ghcr.io/binclusive/binclusive:0`
in your own job — rather than through this Action.

## Removed: `Binclusive/a11y/action-url@v0`, the URL-scan Action — 2026-08-10

**What.** The `action-url/` Action is deleted. `uses: Binclusive/a11y/action-url@v0` no longer
resolves. Tags cut before this change still contain it, so a workflow pinned to a commit SHA keeps
working; a workflow on the floating `@v0` will fail to resolve the action.

**The replacement is a local command, and it is unchanged:**

```bash
b8e scan --url https://example.com
```

`b8e scan --url` is **fully supported and was not removed.** Only the GitHub Action wrapper around it
was. Nothing about local URL scanning changed.

**Why.** Two reasons, either sufficient on its own.

1. *It ran the wrong lane's command.* `scan` is the local/human lane, authenticated by a `b8e login`
   session. `ci` is the machine/CI lane. An Action running `scan` is a machine surface invoking the
   human command — a seam with no clean fix, and the in-flight patch for it was about to push machine
   credentials onto the `scan` lane to hide the seam rather than remove it.
2. *It was the commodity lane.* What it delivered was Playwright + axe-core → SARIF, which pa11y-ci,
   Lighthouse CI and axe-core/cli all do today. Binclusive's differentiators are source scanning —
   the static `Binclusive/a11y@v0` Action, which **stays** — and real screen-reader audits.

**If you were using it in CI,** the closest drop-in for rendered-DOM SARIF in a workflow is any of
the commodity tools above; for source scanning keep `Binclusive/a11y@v0`; for a live URL run
`b8e scan --url` locally.

The `:0-browser` image **build lane**, the `binclusive-scan-url` entrypoint and its release lane are
removed separately in the Binclusive monorepo. The already-pushed `ghcr.io/binclusive/binclusive:0-browser`
tag still resolves — nothing new is published to it.
