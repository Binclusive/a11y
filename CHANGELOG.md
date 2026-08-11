# Changelog

This file is **not** a per-release log — `release.yml` tags every `v0.x` automatically and `git log`
is the complete history. It records only **removals and breaking changes to the Action surface**:
the changes a consumer cannot discover from a green build, and the ones a public-code search cannot
warn private repositories about.

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

The `:0-browser` image, the `binclusive-scan-url` entrypoint and its release lane are removed
separately in the Binclusive monorepo.
