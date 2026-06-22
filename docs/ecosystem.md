# The Binclusive a11y ecosystem (the strategic frame)

Status: **Framing doc** · Date: 2026-06-17
Why this exists: the architecture below shaped the migration epic
(Binclusive/monorepo#1646) and the flywheel epic (#1645), but the *framing* itself
was never written down. This is that frame. For the machinery of any one piece,
see `docs/ARCHITECTURE.md` (this engine) and `docs/rfc-corpus-flywheel.md` (the
compounding loop).

> Binclusive is the accessibility layer that travels with the code — one
> ground-truth corpus, surfaced at every latency from the keystroke to the
> shipped audit.

## The thesis (lead with user value)

Every a11y tool today is one of two bad options: a **dumb linter** (axe,
Lighthouse) that dumps hundreds of undifferentiated violations, or a
**consultant audit** that's accurate but lives in a PDF outside the dev loop.
Binclusive's asset is the **corpus** — real audit findings across real orgs —
which turns "here are 400 problems" into "these are the failures that actually
happen, ranked, with the fix." Prioritization from real-world frequency is the
product. That's the difference between a tool that gets kept and one that gets
uninstalled.

## Three layers, one corpus, one CLI

Not competitors — different layers of the same stack, each serving a different
user at a different moment. **Same corpus, three latencies:**

| Layer | User | Moment | What it is | Lives in |
|---|---|---|---|---|
| Agent skills | the AI writing the code | **write-time** | prompt skills, multi-tool, multi-platform | `atakan-nalbant/Binclusive-Accessibility-Skills` (to be grounded) |
| Local engine + corpus | the developer | **commit-time** | deterministic checker, offline, source-grounded | this repo → `monorepo/packages/a11y-checker` |
| Cloud platform CLI | audit team + buyer | **audit-time** | rendered, agentic, ticketed, SARIF | `monorepo/packages/cli` |

The CLI (`b8e`, built on `@effect/cli`) is the **single spine**: `b8e check`
(local), `b8e audit` (cloud), `b8e mcp`, `b8e skills install`. One install, one
auth, one mental model — surfaced wherever the user already is. (Today this engine
ships that CLI as `a11y-checker`; `b8e` is the converged spine it folds into.)

## The flywheel (why it compounds)

A static corpus decays. The loop that makes the asset compound:

```
cloud audits → new findings → re-cluster → corpus grows
   → sharper local checker + better-grounded skills → more adoption → more audits
```

This fuses the two halves of the company: the **audit system produces** findings,
the **tooling consumes** them, and each makes the other more valuable. Design +
safety of this loop is its own RFC (`docs/rfc-corpus-flywheel.md`, epic #1645).

## The non-negotiables (what must stay true)

1. **One verdict, not three.** A developer must never get "fine" from `b8e
   check`, a different answer from a skill, and a third from the cloud audit.
   Local = "provable from source," cloud = "observable at runtime" — the gap is
   *explained, not hidden* (the coverage-bucket honesty, extended across layers).
2. **Skills grounded, not vibing.** The agent skills must call the real engine
   and read the real corpus instead of hand-seeded patterns. Litmus test:
   `audit-accessibility` and `b8e check` agree on the same file.
3. **Honest depth per platform.** Deterministic where there's an engine
   (React/TSX); corpus-guided-agent where there isn't yet (ASPX/Swift). Say which.
4. **The corpus only improves or holds.** The flywheel is monotonic — a
   regeneration can add or improve a pattern, never silently delete/downgrade a
   blessed one (see the flywheel RFC's keystone invariant).

## One-line summary

> CLI is the spine, corpus is the soul, agents are the bet — and the flywheel is
> what makes every audit we run make every developer's tool sharper.
