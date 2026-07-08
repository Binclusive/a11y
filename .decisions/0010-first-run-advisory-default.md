---
id: 0010
title: First-Run Gating Is Advisory by Default — Blocking Is Opt-In
status: accepted
date: 2026-07-08
tags: [enforcement, cli, onboarding, product, gate]
---

# 0010 — First-Run Gating Is Advisory by Default, Blocking Is Opt-In

## Context

`enforcementFor(wcag, contract)` tags every finding `block` or `warn`, and the
CLI exit code (`gateExitCode`) fails the build only when a finding is `block`
(with the opt-in `--fail-on` / `--max-violations` gate layered on top). When
there **is** a committed `binclusive.json`, the customer's `enforcement.block`
list decides which findings block — the intended, declared policy.

The open question (issue #184) was the **zero-config** case: what should
`enforcementFor(wcag, null)` return when there is **no** `binclusive.json`? It
returned `"block"` for **every** finding. So a first-run scan with no config —
`check`, `check-swift`, `check-shopify`, and every other command, now uniformly
after #176 — gated (exit 1) on **all** findings. A new user pointing the tool at
their repo with no config got a hard, red build on every finding.

That default is wrong for two reasons:

- **It contradicts the tool's own documented promise.** The README states the
  scan is "**advisory by default: it exits 0** and never blocks a merge." The
  zero-config code did the opposite.
- **It is a day-one uninstall trigger.** "Install → red build on every finding"
  is the failure mode that gets an a11y tool removed before it earns trust. The
  onboarding quickstart (#164 / #2272) had to explain "it'll fail your build on
  the first run," which is not the first-touch experience we want.

The consistency across commands (#176) is correct and unchanged here; only the
**default disposition** is at issue. This is a product decision, and the code
follows it — the fork is **strict-block-all-by-default** vs
**advisory-until-opt-in**.

## Decision

**A first run with no `binclusive.json` is ADVISORY, not strict-block-all.**
With no committed contract, `enforcementFor(wcag, null)` returns the advisory
disposition (`warn`) for **every** finding — findings are reported, but none
block, so a zero-config scan exits 0.

**Blocking is a deliberate opt-in.** It is re-armed by either of two surfaces,
never by default:

- **A committed `binclusive.json`** — the customer declares `enforcement.block`
  and those SC block exactly as today. A *configured* contract governs unchanged;
  this decision changes only the no-contract baseline.
- **A CLI/Action gate flag** — `--fail-on <impact>` / `--max-violations <n>` (and
  the equivalent Action inputs). These are layered on **top** of the advisory
  baseline: the exit gate evaluates impact/volume independent of the per-finding
  `block`/`warn` disposition (`gateExitCode`'s gated branch), so a gate flag
  forces a failing exit even when every finding is advisory. Advisory-default is
  the no-config **baseline**, never a **cap** — the flags always override it.

The no-contract case is made an **explicit advisory path**, not an accidental
fall-through: it returns a named `NO_CONTRACT_ENFORCEMENT` constant
(`src/config-scan.ts`), so the zero-config disposition is stated and testable at
its single load-bearing site rather than implied by a bare `return "block"`.

## Consequences

- `enforcementFor(wcag, null)` returns `warn` (advisory) for all findings; a
  zero-config scan across every command reports findings and exits 0 instead of
  red-building on first touch. The README's "advisory by default" promise now
  matches the code.
- A **configured** `binclusive.json` is unaffected — declared `enforcement.block`
  SC block exactly as before.
- The opt-in gate flags (`--fail-on` / `--max-violations`, Action inputs) still
  force a failing exit on top of the advisory baseline; blocking stays fully
  available, just no longer the silent default.
- Guarded by unit tests: `test/config-scan.test.ts` asserts the advisory
  disposition for the no-contract case, and `test/impact-gate.test.ts` verifies
  the three end-to-end scenarios (no-contract advisory ⇒ exit 0; configured-block
  ⇒ exit 1; gate flag with no contract ⇒ exit 1) over the real
  `enforcementFor` → `gateExitCode` path.
- The corpus baseline (`baseline.json`) moves: the SHA-pinned repos are scanned
  with no committed contract, so their per-finding enforcement disposition flips
  `block` → `warn`. The **findings themselves are unchanged** — same rules, same
  locations, same coverage — only their gate disposition flips, which is exactly
  the intended effect of this decision. The baseline is re-blessed in the same PR.
- Follow-up (onboarding-doc alignment, #164 / #2272) is filed against this
  decision, per the issue's acceptance criteria.
