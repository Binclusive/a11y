---
id: 0008
title: Android a11y — Compose-Only Scope, a Clean PSI Engine, and Provenance-Tagged Naming
status: accepted
date: 2026-06-30
tags: [architecture, android, compose, kotlin, producer, naming]
---

# 0008 — Android a11y: Compose-Only Scope, a Clean PSI Engine, and Provenance-Tagged Naming

## Context

Epic #108 adds Android support to the checker, which today covers React/TSX,
Liquid, Unity, and SwiftUI but has *nothing* for Android's modern UI stack —
`Language` is `"ts" | "js"`, there is no `collect-kotlin.ts`, and
`detect-stack.ts` has no Android branch. A Compose project scanned today finds
zero issues, which reads as "clean" when it means "unsupported."

The problem this ADR settles is that the repo shows **two half-started, mutually
disagreeing Android efforts**, and every implementation slice (#112–#118) would
otherwise re-derive which one is real:

- **`kotlin/A11yKotlinScan/`** — untracked (`git ls-files kotlin/` is empty).
  On disk it is **only build output**: `.gradle/`, `build/` (a compiled
  `A11yKotlinScan.jar`, `ComposeRuleTest`/`ViewRuleTest` test-result XML), and a
  stray `.kotlin/errors/*.log`. **There are no committed `.kt` sources.** Its
  compiled classes target **Jetpack Compose**.
- **`experiments/android-matrix/`** — untracked experiment cache. Its
  `results/*.json` (NewPipe, AntennaPod) were produced by an **XML-layout**
  scanner: every `ruleId` is `android-xml/control-no-name` or
  `android-xml/image-no-label`, over `res/layout/*.xml`.

So the compiled scaffolding targets Compose while the only captured results
target XML layouts — a genuine fork the codebase does not resolve. Four
sub-decisions gate all of #112–#118: (1) surface scope, (2) reuse vs restart,
(3) Kotlin parsing approach, (4) provenance / rule-id / `Language` naming.

The binding precedent is the **SwiftUI collector** (`src/collect-swift.ts` +
`swift/A11ySwiftScan`), the proven out-of-process-engine → `Finding`-JSON
pattern (ADR 0002 flat command table, ADR 0003 deterministic shell, ADR 0004
external static analyzer for Unity): an engine parses `.swift` with **SwiftSyntax**
(the official first-party parser), emits the `Finding` contract, and a thin TS
boundary maps it to `provenance: "swiftui"` / rule prefix `swiftui/`. Crucially,
the Swift and Unity collectors tag their platform via **`provenance`**, *not* via
`Language` — `Language` remains `"ts" | "js"` and is documented as "source
language of the repo, decided by tsconfig presence" (the JS-vs-TS distinction on
the DOM/jsx-a11y path), never a per-collector platform tag. The **precision
invariant** (a wrong host is worse than opaque) governs the parser choice.

## Decision

The Android collector mirrors the SwiftUI collector exactly. The four forks
resolve as:

1. **Surface scope — Jetpack Compose `.kt` source only. Android XML layouts are
   out of scope for this epic.** Compose is the direct SwiftUI parallel: a modern
   declarative UI stack scanned from first-party source, the surface the compiled
   `A11yKotlinScan` scaffolding already targets. XML-layout scanning is a
   *different* engine (DOM-like attribute checks over `res/layout/*.xml`) and a
   separate corpus; it is **deferred** to a possible follow-up epic, not assumed
   here. The epic ships its first rule (`compose/image-no-label`) end-to-end on
   the Compose surface.

2. **Reuse vs restart — restart the engine clean; do not adopt
   `kotlin/A11yKotlinScan/`.** There is nothing to adopt: the untracked dir holds
   **zero committed sources**, only build artifacts (`.gradle/`, a compiled
   `.jar`, test-result XML, an errors log). You cannot build on a tree with no
   source. The engine is created fresh under `kotlin/A11yKotlinScan/`, modeled on
   the committed shape of `swift/A11ySwiftScan` (a Gradle project with
   `build.gradle.kts` + `src/main/kotlin` sources, the Gradle analogue of
   `Package.swift` + `Sources/`). The untracked build output and
   `experiments/android-matrix/` are **discarded** (neither is in git; both are
   superseded by this decision and by the fresh artifacts the implementation
   children produce).

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
   - **`Language` does NOT gain `"kotlin"`.** It stays `"ts" | "js"`. The platform
     is carried by `provenance: "compose"`, consistent with how SwiftUI and Unity
     are wired — neither added a `Language` member. Extending `Language` would
     conflate "JS-vs-TS on the DOM path" with "which collector ran" and break the
     `tsconfig`-presence semantics the field documents. The Android surface is
     instead recognized by `detect-stack.ts`'s new Android branch (child #113),
     not by a `Language` value.

Children #112–#118 cite this ADR as the single settled architecture.

## Consequences

- **Easier.** Every implementation slice builds against one architecture instead
  of re-litigating the Compose-vs-XML fork. The collector reuses the entire
  SwiftUI layering (engine → thin TS boundary → CLI verb → MCP tool → editor hook
  → stack detection → corpus matrix), so each layer is a known shape, not a new
  design. `provenance`-based tagging means the report, dedup, enforcement gate,
  and `core.ts` types absorb Compose with one union member and no `Language`
  churn.
- **Harder / banned.** Android **XML-layout** scanning is now out of scope; the
  `experiments/android-matrix/` XML results and the untracked
  `kotlin/A11yKotlinScan/` build output are **discarded, not a starting point** —
  reintroducing either as the basis for the engine is banned. Adding `"kotlin"` to
  `Language` is banned; use `provenance: "compose"` + the detect-stack branch.
- **Migration cost.** The engine starts from an empty `kotlin/A11yKotlinScan/`
  source tree (child #112), so the Gradle scaffolding is written once from
  scratch (mirroring `swift/A11ySwiftScan`). The reused `android-matrix` *name*
  (child #118) now denotes a **Compose** corpus over SHA-pinned `.kt` repos with a
  blessed `baseline.json` — not the discarded XML experiment cache. A future XML
  surface, if pursued, is a separate epic with its own provenance
  (`android-xml`/similar) and corpus.
