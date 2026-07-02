---
id: 0009
title: Reject ADR-Sequence Collisions with a Combined-Tree Gate, Not At-Branch Reservation
status: accepted
date: 2026-06-30
tags: [process, decisions, concurrency, gate, ci]
---

# 0009 — Reject ADR-Sequence Collisions with a Combined-Tree Gate

> **Numbering note:** this ADR originally claimed `0006`, but that id — and the
> `0007`/`0008` past it — were already taken by ADRs that merged ahead of it
> (`0006` reporter-adapter-seam, `0007` swiftui-scope from #120, `0008`
> android-collector-scope from #121) — exactly the cross-PR collision class this
> decision gates — so it was renumbered to the next free id, `0009`.

## Context

`write-code` allocates the next ADR number by reading the current high-water
mark of the monotonic `.decisions/` sequence at **branch-creation time**, with
**no reservation** on that shared number. When two decision-builders are fanned
out in parallel (the epic #66 fan-out that surfaced this: #67 → PR #75, #68 → PR
#76), neither branch can see the other's in-flight id, so both derive the **same**
next number — `0004` — and collide silently when their branches reach `main`:
two distinct `.decisions/0004-*.md` files and two `0004` rows in
`.decisions/index.md` (issue #77).

The collision is **invisible to per-PR review**. Each PR is internally
consistent — one ADR file, one index row, a coherent id — so each `review-code`
gate passes it individually. The duplicate id and the garbled index row only
manifest in the **combined tree**, once both branches merge. This is the same
*class* of defect as #84 (a per-PR gate cannot see a cross-PR collision on shared
global state — there a shared test-fixture dir, here the ADR sequence number).
The two are not duplicates, but they share this systemic fix surface; #77 + #84
are candidates for a future plan-epic umbrella. See #84.

The fork for fixing #77: **prevent the collision at allocation time** (a
reservation/claim on the next id, allocate-at-merge/rebase rather than
at-branch-creation, or serialize decision-builders), versus **detect and reject
the collision over the combined tree**.

## Decision

Reject the collision with a **combined-tree gate** over `.decisions/`, rather
than reserve the sequence number at branch-creation time.

The gate (`src/decisions-lint.ts`, runnable as `pnpm decisions:check`) scans the
`.decisions/` directory and **fails loud** on:

- **Duplicate ADR file ids** — two `NNNN-*.md` files sharing the same 4-digit
  sequence number.
- **Duplicate index rows** — two `index.md` rows for the same id.
- **File ↔ index drift** — an ADR file with no index row, or an index row with no
  ADR file, and a frontmatter `id:` that disagrees with the filename.

It runs **locally** and is intended to run in **CI on the merge result** (the
combined tree of `main` + the merging branch), which is the only vantage point
from which a cross-PR collision is visible. A non-empty finding set is a
hard non-zero exit: the collision is **rejected**, not shipped.

### Why detection over at-branch reservation

The acceptance criteria for #77 explicitly permit the collision to be "detected
and rejected" rather than prevented at allocation time, and detection is the
**in-repo-actionable** mechanism:

- The allocation step lives in the `write-code` **skill** (an out-of-repo plugin),
  so a durable at-branch reservation cannot be landed from this repo. A
  combined-tree gate is wholly owned here, in code + CI this repo controls.
- A reservation/claim protocol adds a stateful coordination surface across
  concurrent agents (the exact shared-state race that *caused* the bug); the gate
  is **stateless** — it reads the merged tree and decides, with no cross-agent
  protocol to get wrong.
- The gate matches the established repo idiom: a shared-global-state check that
  runs over the combined result (cf. the `matrix:check` corpus gate). It also
  composes with — and does not preclude — a future at-allocation reservation: if
  the skill later reserves ids, this gate remains the backstop that proves the
  reservation held.

The remaining gap detection leaves open — that two colliding PRs each pass review
and the collision is only caught at the merge gate — is **acceptable and
correct**: the merge is blocked, a human/agent renumbers the loser (exactly the
`0004` → `0005` renumber that resolved the original instance), and `main` never
carries a duplicate id. Loud rejection at the merge boundary is the guarantee #77
asks for.

## Consequences

- `.decisions/` integrity is enforced by `pnpm decisions:check` and a regression
  test (`test/decisions-collision.test.ts`) that reproduces the #77 two-PR
  collision over a combined-tree fixture and asserts it is rejected, and that the
  real `.decisions/` stays collision-free.
- A parallel decision-builder fan-out can still *produce* two colliding branches;
  what changes is that the collision can **no longer reach `main` silently** — the
  gate rejects the merged tree until the duplicate is renumbered.
- This does not fix #84 (shared test-fixture collisions); it is the ADR-sequence
  instance of the same combined-tree-gate pattern that #84 can adopt.
