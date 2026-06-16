---
id: 0003
title: A Deterministic Shell Around Every Stochastic Capability
status: accepted
date: 2026-06-16
tags: [architecture, detection, corpus, agent]
---

# 0003 — A Deterministic Shell Around Every Stochastic Capability

## Context

Phase 1 adds a corpus-grounded recall layer: the agent reads real-world failure
patterns and nominates findings the static floor misses. The design spike's
adversarial critique surfaced a systematic failure mode — the dominant false
positive is not a hallucination but a *misclassification* of real, correctly
located code whose accessible name lives off the call site (a Tooltip-titled
`IconButton`, a `FormLabel`-wrapped input, a `rendersOwnName` wrapper). Every
syntactic gate (closed vocabulary, verbatim quote, exact location, confidence,
tier) waves it through, because each verifies the offending code *exists*, not
that the violation is *real*. These false positives concentrate on the most
common components in the most common journeys — i.e. exactly where the layer runs
most — and a single such finding erodes trust in the deterministic floor too.

The root cause: letting the model make a precision-critical binary verdict. The
static floor's precision is ~8 *deterministic* suppressors (`hasNameAncestor`,
`hasLabelAncestor`, `rendersOwnName`, toggle-role, type-exempt, …). Replacing
them with a stochastic self-check inverts the floor's entire FP discipline.

## Decision

Every stochastic capability ships inside a deterministic shell, and the model is
never the thing that decides what ships.

- **The model proposes; deterministic code disposes.** The model is bounded to
  fuzzy recognition over the long tail (candidate nomination). It is forbidden
  from every binary precision verdict — those are made by deterministic code.
- **Model output is untrusted input.** It crosses a boundary of deterministic
  gates (parse-don't-validate); only what survives the gates becomes a trusted
  `Finding`. Precision lives only in code we can prove.
- **The shell reuses the deterministic core, not a second opinion.** Phase 1's
  precision gate (G3) is the floor's *own* suppressor walk, lifted into a shared
  module and run server-side over the agent's nominations — not a stochastic
  re-check. The abstention veto (G4) treats the floor's deliberate silence as a
  veto, not as permission to flag.
- **Every stochastic layer carries a statistical proof its shell holds.** The
  recall layer is gated by `recall:eval` — a Wilson lower-bound precision floor
  (≥ 0.95) over hard decoys — separate from the floor's count-snapshot
  (`matrix:check`). No stochastic capability is trusted without such a proof.
- **Stochastic output is quarantined and advisory.** It never enters the
  deterministic finding stream (`scan()`), never sets a build/exit code, never
  blocks by default, and carries a distinct provenance so consumers calibrate
  trust (`floor` = certain, `recall` = likely-at-floor).

## Consequences

- **Banned:** shipping any model verdict as a binding result without passing
  deterministic gates; using a stochastic self-check as the *sole* precision
  defense; mixing stochastic findings into the deterministic count stream.
- **Required:** for any new AI capability — a deterministic shell (reusing
  existing invariants where possible), a quarantine boundary, and a statistical
  proof (an eval with a precision/quality floor) before it is trusted or enabled
  by default.
- **Enables agent-grade durability** — the reason this matters beyond precision:
  a deterministic precision guarantee is *reproducible* (same code → same
  verdict), so an agent can build on it without churn; provenance gives
  *calibrated* trust, not blind trust; quarantine + advisory framing *bound the
  blast radius* of any miss. This is what turns "an LLM that guesses about
  accessibility" into a primitive agents can depend on. It is the moat expressed
  as engineering: a pure-LLM tool is all untrusted periphery and no kernel.
- **Cost:** every AI feature carries the overhead of its shell and its eval. We
  accept this — the alternative (trusting model verdicts directly) is the failure
  mode that gets the tool uninstalled.
- This is a standing law, not a Phase-1 detail: it governs Phase 2 ingestion and
  any agent-facing capability built hereafter.
