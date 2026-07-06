---
id: 0006
title: A Per-Platform Reporter-Adapter Seam (Diff-Context Resolver + Findings Reporter)
status: accepted
date: 2026-07-05
tags: [architecture, ci, adapter, reporting]
---

# 0006 — A Per-Platform Reporter-Adapter Seam

## Context

The CI glue was GitHub-hardcoded across two root files: `entrypoint.sh` derived
the PR context (`PR_NUMBER` / `BASE_SHA` / `HEAD_SHA` from `GITHUB_EVENT_PATH`) and
the changed-file scope inline, and `pr-comment.mjs` posted inline PR review
comments via the GitHub REST API. There was no boundary, so a second CI platform
(Buildkite #2237, GitLab #2238 — children of the multi-CI epic #2135) could not be
added without forking the entrypoint.

This is a different axis than ADR 0002. There we **rejected** a `Collector`
abstraction over four finding *producers* because they shared only shape, not
behavior, and there was no real second consumer — "three similar lines beat a
premature abstraction." Here the abstraction earns its place: the epic has **named,
planned second and third platforms**, and every platform does the *same behavior*
(resolve a change-context, then surface findings on a native review UI) over
different env and different APIs. That is "one thing seen N ways," which is exactly
what 0002 says to abstract.

## Decision

Introduce a **platform-adapter seam** (`src/reporter/`) with two halves behind one
contract, and refactor the existing GitHub behavior into the first adapter:

- **`DiffContextResolver<Ctx>`** — resolves the platform's change-context from
  `env`: the changed `.tsx` to scan and a `postTarget: Ctx | null` (the native
  post surface, or `null` when there is no PR/MR context).
- **`FindingsReporter<Ctx>`** — consumes the canonical `@binclusive/a11y-contract`
  finding shape (`Finding`, the engine's `check --json` output, ADR 0039) and posts
  to the platform's native review UI.
- **`PlatformAdapter<Ctx>`** pairs the two over one post-target type. `bindAdapter`
  erases `Ctx` into a `BoundAdapter` by capturing the resolver's target in the
  closure it hands the reporter — so an `AdapterRegistry` stores adapters of
  different `Ctx` types with **no cast and no `any`**. Selection is by explicit
  platform key (`A11Y_PLATFORM`), defaulting to `github`.

Two adapters ship, proving the seam holds **≥ 2 platforms**:

- **`github`** — the first adapter. The resolver reads the same `GITHUB_*` env and
  diff scope as before; the reporter is the former `pr-comment-cli.ts` body
  (branded-App-or-`GITHUB_TOKEN` identity #2130, the de-dup reconcile #2131). The
  shipped Action is behavior-preserving: default key `github`, and the resolver
  reproduces the old skip guard (a `null` target ⇒ no-op) exactly.
- **`null`** — the generic, no-native-UI adapter that writes each finding to a sink
  (stdout). Deliberately not GitHub-shaped (no PR identity, no credential, no
  reconcile), it is the trivial second implementation and the seed for the generic
  `--ci` mode (#2236).

**Opt-in, no-context no-op:** when the resolver yields `null`, `dispatch` skips the
reporter — artifacts still emit and the advisory gate still exits 0.

## Consequences

- `entrypoint.sh` calls one `report.mjs` unconditionally; the *seam* owns the
  opt-in decision, so the shell no longer carries a GitHub-specific credential gate.
- A new platform is one adapter + one registry row — it touches neither the
  entrypoint nor the GitHub adapter. This is what unblocks #2236/#2237/#2238.
- Out of scope here (their own children): the Buildkite/GitLab reporters and the
  generic `--ci` mode. This ADR is the contract they plug into.
