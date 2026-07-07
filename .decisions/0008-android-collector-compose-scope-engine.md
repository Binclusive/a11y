---
id: 0008
title: Android a11y — Compose + XML Layout Scope, a Clean PSI Engine, and Provenance-Tagged Naming
status: accepted
date: 2026-07-02
tags: [architecture, android, compose, android-xml, kotlin, producer, naming]
---

# 0008 — Android a11y: Compose + XML Layout Scope, a Clean PSI Engine, and Provenance-Tagged Naming

## Context

Epic #108 adds Android support to the checker, which at the epic's framing
covered React/TSX, Liquid, Unity, and SwiftUI but had *nothing* for Android —
no Android collector, and no Android branch in `detect-stack.ts`. An Android
project scanned then found zero issues, which reads as "clean" when it means
"unsupported."

The problem this ADR settles is that the repo showed **two half-started,
mutually disagreeing Android efforts**, and every implementation slice
(#112–#118) would otherwise re-derive which one is real:

- **`kotlin/A11yKotlinScan/`** — untracked (`git ls-files kotlin/` is empty).
  On disk it is **only build output**: `.gradle/`, `build/` (a compiled
  `A11yKotlinScan.jar`, `ComposeRuleTest`/`ViewRuleTest` test-result XML), and a
  stray `.kotlin/errors/*.log`. **There are no committed `.kt` sources.** Its
  compiled classes target **Jetpack Compose**.
- **`experiments/android-matrix/`** — an (initially untracked) experiment
  cache. Its `results/*.json` (NewPipe, AntennaPod) were produced by an
  **XML-layout** scanner: every `ruleId` is `android-xml/control-no-name` or
  `android-xml/image-no-label`, over `res/layout/*.xml`.

So the compiled scaffolding targets Compose while the captured prototype
results target XML layouts. The XML half of that fork has since been resolved
by shipping: **PR #122 (fixes #109)** committed the in-process Android XML
layout collector (`src/collect-android-xml.ts`), the `check-android` CLI verb,
an Android branch in `detect-stack.ts`, and `experiments/android-matrix` as the
XML path's committed regression gate with a blessed `baseline.json`. Four
sub-decisions gate all of #112–#118: (1) surface scope, (2) reuse vs restart,
(3) Kotlin parsing approach, (4) provenance / rule-id / `Language` naming.

The binding precedent is the **SwiftUI collector** (`src/collect-swift.ts` +
`swift/A11ySwiftScan`), the proven out-of-process-engine → `Finding`-JSON
pattern (ADR 0002 flat command table, ADR 0003 deterministic shell, ADR 0004
external static analyzer for Unity): an engine parses `.swift` with **SwiftSyntax**
(the official first-party parser), emits the `Finding` contract, and a thin TS
boundary maps it to `provenance: "swiftui"` / rule prefix `swiftui/`. Crucially,
the Swift and Unity collectors tag their platform via **`provenance`**, *not* via
`Language` — for them `Language` stayed `"ts" | "js"`, documented as "source
language of the repo, decided by tsconfig presence" (the JS-vs-TS distinction on
the DOM/jsx-a11y path), never a per-collector platform tag. The **precision
invariant** (a wrong host is worse than opaque) governs the parser choice.

## Decision

Both Android UI surfaces are in scope, as sibling collectors; the Compose
collector mirrors the SwiftUI collector exactly. The four forks resolve as:

1. **Surface scope — both Android surfaces are in scope: Jetpack Compose `.kt`
   source AND Android XML layouts (`res/layout*/*.xml`).** They are sibling
   surfaces with different engines:
   - **Android XML layouts** are covered by the **in-process XML collector
     shipped in PR #122 (fixes #109)**: `src/collect-android-xml.ts` with the
     rules `android-xml/image-no-label` and `android-xml/control-no-name`, the
     `check-android` CLI verb, and the `experiments/android-matrix` regression
     gate with a committed `baseline.json`. Android layouts are plain XML, so
     the engine runs **in-process in Node — no second toolchain**. XML-layout
     scanning is **no longer deferred**.
   - **Jetpack Compose** is scanned from first-party `.kt` source — the direct
     SwiftUI parallel: a modern declarative UI stack, the surface the compiled
     `A11yKotlinScan` scaffolding already targeted. Because parsing Kotlin
     needs a real frontend, this surface **requires the external
     compiler-embeddable/PSI engine** (forks 2 and 3), run out-of-process and
     mirroring `swift/A11ySwiftScan`. The epic ships its first Compose rule
     (`compose/image-no-label`) end-to-end on this surface.

2. **Reuse vs restart — restart the Kotlin engine clean; do not adopt
   `kotlin/A11yKotlinScan/`.** There is nothing to adopt: the untracked dir holds
   **zero committed sources**, only build artifacts (`.gradle/`, a compiled
   `.jar`, test-result XML, an errors log). You cannot build on a tree with no
   source. The engine is created fresh under `kotlin/A11yKotlinScan/`, modeled on
   the committed shape of `swift/A11ySwiftScan` (a Gradle project with
   `build.gradle.kts` + `src/main/kotlin` sources, the Gradle analogue of
   `Package.swift` + `Sources/`). The untracked build output is **discarded**
   (it is not in git and is superseded by the fresh engine the implementation
   children produce). The XML `experiments/android-matrix` experiment is
   **adopted, not discarded**: PR #122 committed it as the XML path's
   regression gate (manifest, run/check scripts, blessed `baseline.json`
   reproducing the prototype's NewPipe/AntennaPod results).

3. **Parsing approach — the Kotlin compiler-embeddable / PSI.** This is the
   SwiftSyntax analogue: the official, first-party Kotlin frontend, giving a real
   AST with precise source positions. That precision is what the invariant demands
   — accurate host/semantic resolution so an unresolvable construct stays **opaque
   (unflagged)** rather than mis-flagged. `detekt` is rejected: it is a linter
   *framework* with its own rule API and heavier opinions layered over PSI, adding
   a dependency without giving more control than PSI directly. A regex/lightweight
   parser is rejected outright — it cannot meet the precision invariant. The engine
   is Gradle-built and run out-of-process (per ADR 0004), emitting the `Finding`
   JSON contract that `Finding.swift` already defines.

4. **Naming —**
   - **`FindingProvenance` gains `"compose"`** (added to the union in
     `src/core.ts`), tagging every finding the Compose engine produces — exactly
     as `"swiftui"` / `"unity"` tag theirs.
   - **Rule-id prefix is `compose/`** (e.g. `compose/image-no-label`,
     `compose/control-no-name`), mirroring `swiftui/`.
   - **The XML sibling surface is named per PR #122**: its findings carry
     `provenance: "android-xml"` with rule prefix `android-xml/`, and
     `Language` carries `"android-xml"` as the detect-stack routing value for
     an Android project (a Gradle/manifest layout with `res/layout*`).
   - **`Language` does NOT gain `"kotlin"`.** The Compose platform is carried by
     `provenance: "compose"`, consistent with how SwiftUI and Unity are wired —
     neither added a `Language` member. Adding `"kotlin"` would conflate
     "JS-vs-TS on the DOM path" with "which collector ran"; the Android surface
     is instead recognized by `detect-stack.ts`'s Android branch (shipped for
     XML in #122, extended for Compose in child #113), not by a Kotlin
     `Language` value.

Children #112–#118 cite this ADR as the single settled architecture.

## Consequences

- **Easier.** Every implementation slice builds against one architecture instead
  of re-litigating the Compose-vs-XML fork — both surfaces are settled, and the
  XML sibling has already landed end-to-end (PR #122) with its own regression
  gate, so the Compose children face no open scope question. The Compose
  collector reuses the entire SwiftUI layering (engine → thin TS boundary → CLI
  verb → MCP tool → editor hook → stack detection → corpus matrix), so each
  layer is a known shape, not a new design. `provenance`-based tagging means
  the report, dedup, enforcement gate, and `core.ts` types absorb Compose with
  one union member and no further `Language` churn.
- **Harder / banned.** The untracked `kotlin/A11yKotlinScan/` build output is
  **discarded, not a starting point** — reintroducing it as the basis for the
  engine is banned. Adding `"kotlin"` to `Language` is banned; use
  `provenance: "compose"` + the detect-stack branch (the XML surface's
  `"android-xml"` routing value from #122 is the one Android `Language`
  member).
- **Migration cost.** The engine starts from an empty `kotlin/A11yKotlinScan/`
  source tree (child #112), so the Gradle scaffolding is written once from
  scratch (mirroring `swift/A11ySwiftScan`). The `experiments/android-matrix`
  name is **taken by the XML path's regression gate** (PR #122), so the Compose
  corpus (child #118) lands under a distinct name (e.g.
  `experiments/compose-matrix`) with its own SHA-pinned `.kt` repos and blessed
  `baseline.json` — it does not overwrite the XML gate.
