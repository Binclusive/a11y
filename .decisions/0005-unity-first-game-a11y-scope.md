---
id: 0005
title: Unity-First as the Wedge for the Game A11y Checker
status: accepted
date: 2026-06-24
tags: [scope, positioning, game-a11y, unity]
---

# 0005 — Unity-First as the Wedge for the Game A11y Checker

## Context

The game-a11y checker initiative (#66) faces a scope/positioning fork: build a
**Unity-only** checker, or an **engine-agnostic** one that also targets Godot and
Unreal. The fork is load-bearing because the three major engines have **opposite
accessibility defaults**, and that default decides how much of any rule set
transfers across engines:

- **Unity — authored from scratch.** There is no accessibility tree unless the
  developer hand-builds an `AccessibilityHierarchy` in C#. The default state is
  **zero**. (Unity 6 accessibility-module docs.)
- **Godot 4.5 (2025) — auto-derived.** Godot integrated **AccessKit**; once a
  screen reader is active the accessibility tree is derived automatically from the
  Control-node scene tree. ("All base (non-editor) controls should work now" —
  godotengine/godot PR #76829; https://godotengine.org/releases/4.5/.)
- **Unreal — accessible-by-default since UE 4.23.** UMG/Slate widgets are exposed
  to screen readers automatically; a custom widget overrides
  `SWidget::CreateAccessibleWidget()` to participate.
  (https://dev.epicgames.com/documentation/en-us/unreal-engine/supporting-screen-readers-in-unreal-engine)

The consequence is asymmetric value, not just asymmetric market size. The single
**most valuable** finding a game-a11y checker can produce — *"there is no
accessibility tree / no screen-reader support at all"* — exists **only in Unity**,
because only Unity defaults to zero. On Godot and Unreal the engine already
supplies that baseline, so the finding is structurally absent: there is nothing to
report. Only the **higher WCAG-style layer** generalizes across all three engines —
contrast, text scaling, color-only state encoding, input rebinding, captions.

So the fork is really: go **Unity-deep** (the richest, most unique checkable
surface, smaller addressable market) versus **engine-agnostic-shallow** (a bigger
market, but only the thin shared WCAG-layer, with no "is there even a tree" wedge).
Leading engine-agnostic would discard the sharpest differentiator — the zero-default
Unity gap — in exchange for a thin common denominator. Two further facts bound the
decision: **no static a11y linter exists for any game engine today** (the niche is
empty everywhere, so Unity-first is a wedge into open ground, not a niche within a
niche), and the only adjacent prior art found is an academic, non-productized
prototype (UA11Y, University of Hawaii).

## Decision

**Build Unity-first as the wedge. Defer engine-agnostic to a later expansion.**

- The entry point is a **Unity-only** checker whose deepest rules exploit Unity's
  zero-default — above all *"no accessibility tree / no screen-reader support."*
  This is the surface no other tool checks and no other engine even exposes, and it
  is the most defensible precisely **because** Unity's default is zero.
- The **engine-agnostic WCAG-layer** (contrast, text scaling, color-only state,
  input rebinding, captions) is a **later expansion, not the entry point.** It is
  the only layer that transfers, so it is what a future Godot/Unreal expansion would
  share — but it is a thinner shared rule set and carries no zero-default wedge, so
  it does not lead.
- **Revisit trigger:** reconsider engine-agnostic only if the WCAG-layer rules prove
  to carry the value **on their own** — i.e. if the shared layer turns out valuable
  enough to justify the broader market without the Unity-specific tree wedge. Absent
  that evidence, Unity-deep stays the entry.

## Consequences

- **Enables the sharpest differentiator.** Investing in the zero-default Unity
  surface targets the deepest, most unique checkable problem in the entire space —
  the finding that does not exist anywhere else. This is the moat expressed as scope:
  go where the default is zero, because that is where a static linter has the most to
  say and the most that transfers nowhere else.
- **Bans leading engine-agnostic.** Building the checker against the thin shared
  WCAG-layer first — to maximize TAM — is the inverted sequencing this ADR forbids:
  it spends the initiative's first effort on the rules with the *least* unique value
  and skips the wedge.
- **Smaller initial market, accepted deliberately.** Unity-only is a narrower
  addressable market than engine-agnostic. We accept this as the price of depth and
  defensibility; the empty competitive field (no static a11y linter for any engine)
  means the narrow wedge is still open ground, not a crowded niche.
- **The expansion path is recorded, not foreclosed.** Engine-agnostic is explicitly a
  *deferred later expansion* with a named revisit trigger (the WCAG-layer carrying
  value on its own), so this decision sequences the initiative without closing the
  door on the broader market.
- **Downstream initiative scope (#66, #67) inherits this.** The Unity static-linter
  work and the in-Editor-vs-external architecture decision are both scoped to Unity
  under this ADR; an engine-agnostic abstraction is not a Phase-1 requirement and
  should not be designed for speculatively before the revisit trigger fires.
