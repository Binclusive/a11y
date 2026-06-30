---
id: 0007
title: SwiftUI Collector Scope — Pursue Parity, the 2-Rule Floor Is Not the End State
status: accepted
date: 2026-06-30
tags: [scope, swiftui, collectors, coverage]
---

# 0007 — SwiftUI Collector Scope — Pursue Parity, the 2-Rule Floor Is Not the End State

## Context

The checker has four collectors presented as peers — DOM/jsx, Liquid, Unity, and
SwiftUI — but the SwiftUI path is materially thinner than the TypeScript engine, and
that asymmetry has been **implicit**, not documented. This forced a scope decision
(#107): is SwiftUI/React rule parity a goal for the Swift collector, or is the
current 2-rule static floor the intended scope?

The gap is real and verified:

- **Rule coverage.** The Swift engine emits exactly **2 rules** —
  `swiftui/image-no-label` (WCAG 1.1.1) and `swiftui/control-no-name` (WCAG 4.1.2),
  per `swift/A11ySwiftScan/Sources/A11ySwiftScan/Finding.swift` and `A11yVisitor.swift`.
  The TS path runs the full jsx-a11y rule set plus a corpus-driven content pass.
- **Size.** ~733 LOC of Swift vs ~14,500 LOC of TS in `src/`.
- **Whole subsystems absent on the Swift side:**
  - *Resolver / host-element resolution* (`src/source-trace.ts`,
    `src/resolve-components.ts`, `src/registry.ts`, `src/imports-resolve.ts`,
    `src/module-scope.ts`, `src/tsconfig-aliases.ts`). Swift has only a bounded
    ancestor-climb heuristic (`SyntaxClimb.swift`) — no symbol/import resolution, so
    the custom-wrapper "opacity problem" the SwiftUI skill itself names is unresolved.
  - *Suppression handling* (`src/enforce.ts`, `src/suppression-ranges.ts`,
    `src/suppressors.ts`, `src/suppressor-map.ts`). Swift has none.
  - *Corpus frequency / WCAG enrichment / retrieval* (`src/corpus.ts`,
    `src/retrieve.ts`, `src/wcag-map.ts`, `src/wcag-tags.ts`, `src/distill/`,
    `src/baseline/`).
- **By-design static-only boundary.** The Swift engine is explicitly static-only
  today (`Package.swift` header) — the runtime `performAccessibilityAudit()` half is
  documented in `plugin/skills/swiftui-a11y/SKILL.md` (Layer 2) but not wired — so even
  *within* SwiftUI it covers a narrower surface than the React path covers.

The hazard is twofold. The thinness itself is a coverage gap; but the sharper,
immediate problem is that the thinness was **silent** — a "clean" SwiftUI result could
be read as "fully audited" when it really means the checker is only looking for two
mechanical shapes (unlabeled images, unnamed controls). That is a false-confidence trap
a user could hit *today*. The four collectors are presented as peers, but a SwiftUI
project gets a 2-rule static scan while a React project gets the full resolver +
jsx-a11y + corpus pipeline.

The three options weighed in #107 were: **A** — ratify the floor as intended scope and
just document it; **B** — commit to closing the gap (parity, or a defined subset) and
spin a follow-up epic; **C** — a bounded middle rule set. Option A is the cheapest and
removes only the *silent* part of the risk; it does not remove the coverage gap itself.

## Decision

**The 2-rule static floor is NOT the intended end state. Commit to closing the SwiftUI
coverage gap toward parity with the TypeScript engine (Option B).** The current
asymmetry is treated as a coverage debt to be paid down, not as ratified scope.

- **Parity is the target, pursued incrementally via a planned epic.** The build-out is
  tracked in follow-up epic **#111**, which carries the explicit rule-gap inventory
  (each SwiftUI a11y failure mode mapped to a rule, the way `src/wcag-map.ts` anchors
  the web rules) and breaks the work into pickable children. This ADR records the
  *direction*; #111 holds the *plan*.
- **Scope of "parity" — the static rule set plus its supporting subsystems, then
  runtime.** Closing the gap means more than adding rules: the SwiftUI collector should
  grow (a) the additional static rules in #111's inventory, (b) a **resolver** that
  resolves custom-wrapper opacity across files (the SwiftUI analogue of the TS
  `enforce` pass), (c) **suppression handling**, and (d) **WCAG enrichment** on each
  finding. The runtime `performAccessibilityAudit()` layer (Layer 2) — where the
  source-blind findings (contrast, Dynamic Type, target size) live — is part of closing
  the gap, sequenced as a later phase in #111.
- **The asymmetry must be explicit while the gap is being closed.** Until parity lands,
  a maintainer reading the skill and a user reading a SwiftUI result must both be able
  to see that the static SwiftUI scan is *currently* a 2-rule floor that is *actively
  being expanded* (tracked in #111), so a clean result is never mistaken for a full
  audit in the interim. This is recorded in `plugin/skills/swiftui-a11y/SKILL.md` (an
  explicit **Scope and coverage** section) alongside this ADR.
- **Sequencing.** The Swift collector has no tests/CI (#106); that safety net is a
  prerequisite for confidently expanding the rule set, so #111 sequences it first. The
  rule-gap inventory in #111 is the authoritative breakdown; per-rule and per-subsystem
  work are its children, picked up through the normal pipeline.

## Consequences

- **Removes both the silent risk and (over time) the coverage gap.** Documenting the
  asymmetry closes the *silent* hazard immediately; the #111 epic closes the *coverage*
  gap incrementally. The interim state is honest: "2-rule floor, expansion in progress,"
  never "fully audited."
- **Bans ratifying the floor as final.** Treating the 2-rule scope as the intended end
  state — and therefore *not* building toward parity — is the path this ADR forbids
  (Option A is explicitly rejected). The asymmetry is a debt, not a design boundary.
- **A follow-up epic is required and exists.** Acceptance criterion 3 of #107 (a
  follow-up `type:epic` capturing the rule-gap inventory and pickable children) is
  satisfied by **#111**, which this decision references; #107 in turn references #111.
- **"Peer collector" now carries a parity commitment for SwiftUI.** Where the four
  collectors are presented as peers, SwiftUI is on a stated path to rule-depth parity
  (not only architectural peering). The SwiftUI skill records the current floor and the
  commitment so the peer framing is accurate, not aspirational-by-omission.
- **#106 becomes a sequencing input.** The "no tests/CI" chore is no longer just
  adjacent — it is the prerequisite #111 builds on before expanding rules, so the two
  are now ordered, not merely related.
- **Cost accepted.** Parity is a large, multi-phase build (new static rules + resolver
  + suppression + enrichment + runtime). This ADR commits to it deliberately rather than
  letting the gap persist silently; the work is bounded and made pickable by #111 so the
  commitment is sequenced, not open-ended.
