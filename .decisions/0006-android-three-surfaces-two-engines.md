---
id: 0006
title: Android a11y — Three Surfaces, Two Engines (in-TS XML + external Kotlin/JVM)
status: accepted
date: 2026-06-25
tags: [architecture, android, kotlin, compose, producer, corpus, distribution]
---

# 0006 — Android a11y: Three Surfaces, Two Engines

## Context

Android is the next platform for the checker, and unlike Unity (ADR 0004) the
fork is *not* "external-static vs in-Editor" — Binclusive has already settled
that question for every prior lane: read source at repo/CI time, headless,
reuse the engine, gate on a SHA-pinned corpus. The open question for Android is
narrower and concrete: **what parser produces the `Finding`s for each Android UI
surface, and where does that producer live in the tree** (`src/` in-process, or
a sibling compiled engine like `swift/`).

Android presents **three** accessibility surfaces, but they are not three
independent build problems:

- **Jetpack Compose** — `.kt`, declarative (`@Composable` functions, `Image`/
  `Icon`/`IconButton`, `Modifier.semantics { contentDescription = … }`,
  `clearAndSetSemantics`, `Modifier.clickable`). The direct analog of SwiftUI
  (`collect-swift`): a name may live on the composable or be inherited from a
  semantics-bearing ancestor — the same ancestor-climb the SwiftUI engine runs.
- **Programmatic Kotlin Views** — `.kt`, imperative (`imageView.contentDescription
  = …`, `view.setOnClickListener { … }`, `importantForAccessibility`,
  `AccessibilityDelegate`, custom `View` subclasses). Real a11y defects live here,
  and detecting *absence* ("an `ImageView` that is never given a
  `contentDescription`") benefits from knowing a receiver's type.
- **XML layouts** — `res/layout/*.xml`, static markup (`android:contentDescription`,
  `labelFor`, `android:importantForAccessibility`, touch-target size). The direct
  analog of Liquid (`collect-liquid`): attribute present / dynamic / absent.

The load-bearing observation: **two of the three surfaces are the same source
language.** Compose and programmatic Kotlin are both `.kt`, so they share one
parser and one engine — they are two *rule families*, not two build problems.
XML is a different format with a trivially different (and cheaper) answer. So
"three surfaces" collapses to **two engines**, and the only genuinely open
decision is how to parse Kotlin.

The Kotlin parser choice has two real options, and they keep-or-dissolve the
JVM-toolchain cost in opposite ways:

- **A) External Kotlin/JVM engine** — a small Gradle/Kotlin CLI over the Kotlin
  compiler frontend (`kotlin-compiler-embeddable` PSI, or the Kotlin Analysis API
  when type resolution is wanted) that walks `KtFile` syntax trees and prints the
  JSON `Finding` contract on stdout. Lives in a new top-level `kotlin/` dir,
  parallel to `swift/`; shelled to from `src/collect-android-kotlin.ts` exactly as
  `collect-swift.ts` shells to `swift/A11ySwiftScan`. Cost: ships a JVM toolchain
  and a second compiled build in CI. Buys: the *official* parser (robust on
  Compose's trailing-lambda / `@Composable` DSL) and access to type resolution for
  the programmatic-View surface.

- **B) tree-sitter-kotlin, in-process** — parse `.kt` to a CST inside Node, no
  JVM; analyze the modifier chain / ancestor-climb syntactically, staying in
  `src/` like the Liquid and Unity producers. Cost: a community grammar (not the
  official parser) that will be stressed by Compose's DSL, and **no type/semantic
  resolution** — a CST cannot tell you a receiver is an `ImageView`. Buys: no JVM,
  in-process, lighter, no sibling directory.

The asymmetry mirrors ADR 0004's: option B is the lighter, stay-in-TS path;
option A is the proven, higher-fidelity path that this repo just exercised for
Swift. When the Kotlin scope was **Compose-only**, B was attractive — those
rules (Image/Icon without `contentDescription`, `clickable` without `semantics`)
are syntactic enough for a CST under the conservatism discipline. Committing to
the **programmatic-View surface** is what tips it: that surface benefits from type
resolution, which only the JVM frontend provides.

## Decision

**Build Android as two engines behind one `check-android` verb:**

1. **XML → an in-TS producer** (`src/collect-android-xml.ts`), parsing
   `res/layout/*.xml` in Node with a TS XML parser and emitting `Finding[]`
   directly. No external engine, no sibling directory. This is the Liquid pattern
   (`liquid-ast.ts` + `collect-liquid.ts`) applied verbatim.

2. **Compose + programmatic Kotlin → one external Kotlin/JVM engine** (option A),
   a Gradle/Kotlin CLI in a new top-level `kotlin/A11yKotlinScan`, parallel to
   `swift/A11ySwiftScan`. It parses `.kt` with the Kotlin compiler frontend (PSI;
   the Analysis API where a rule needs type resolution) and prints the same JSON
   `Finding` contract on stdout. `src/collect-android-kotlin.ts` is the thin
   boundary that shells to it — `collect-swift.ts` is the literal template. The two
   Kotlin surfaces are two rule families inside this one engine (`compose/*` and
   `view/*`), not two engines.

**Delivery is one front door, not three.** A real Android project has all three
surfaces at once, so — exactly as Unity ships `check-unity <dir>` — Android ships
a single **`check-android <dir>`** that runs the XML producer *and* the Kotlin
engine, merges the `Finding[]`, and hands off to the shared `enrichAll` → gate →
report. Rule ids are namespaced (`compose/*`, `view/*`, `android-xml/*`) but the
report is one. One row in the `COMMANDS` table, one `runCheckAndroid`, no
contract touched (ADR 0002).

**The precision invariant carries over unchanged.** On an unresolved custom
`View` / `@Composable`, the engine **stays opaque** — it never maps to the wrong
widget. The same "correct host or opaque, never wrong-host" rule the React/Liquid/
Unity resolvers live by.

**The trust gate carries over unchanged.** A SHA-pinned `android-matrix` corpus
+ an `android:matrix:check` analog (the `unity-matrix` pattern) is the
regression gate that makes real-world drift visible in review.

The rules port largely 1:1 from the SwiftUI engine: `image-no-label` → an
`Image`/`Icon` with no `contentDescription` on it or any semantics-bearing
ancestor; `control-no-name` → a `clickable` view/composable whose accessible name
is empty after the climb.

## Consequences

- **A new top-level `kotlin/` directory** joins `swift/` as a sibling compiled
  engine. This is the cost of option A and the most visible structural change:
  the repo now carries two non-Node toolchains. The `src/` ↔ engine-dir line is
  the same one ADR's reading of the tree already draws — the TS boundary
  (`collect-android-kotlin.ts`) lives in `src/`; the compiled engine lives in its
  own dir because Node can't run the Kotlin frontend, exactly as it can't run
  SwiftSyntax.
- **CI gains a JVM/Gradle build.** The Kotlin engine compiles like the Swift
  package does (prebuilt binary preferred, `gradle run` fallback — the
  `collect-swift.ts` two-strategy invocation). This is real CI weight knowingly
  taken on for parser fidelity and type resolution.
- **The XML lane ships first and cheaply**, proving Android findings cluster
  against our WCAG SCs *before* any JVM cost is paid. If the corpus mapping is
  weak, we learn it for the price of a TS producer, not a Gradle project.
- **Type resolution is opt-in, not assumed.** The Compose rules run on plain PSI;
  the programmatic-View rules adopt the Analysis API only where a specific rule
  provably needs a receiver's type. Absent resolution, the engine stays opaque —
  it does not guess a wrong type and emit a false positive.
- **Distribution is npm / GitHub Action / MCP**, the same channel as every other
  lane — not an Android Studio / IDE plugin. We forgo the in-IDE channel (and the
  live view hierarchy it would resolve for free) in exchange for engine reuse and
  the headless corpus methodology, the identical trade ADR 0004 made for Unity.
- **Adding Java later is a sibling pass, not a re-architecture.** Legacy Android
  is often Java; the Kotlin frontend cannot parse it, so Java Views (if they ever
  matter) become an added JavaParser pass in the same JVM engine — out of scope
  here because the committed scope is Kotlin.

### Rejected alternative — tree-sitter-kotlin in-process (recorded honestly)

tree-sitter-kotlin is **not a strawman**, and for a narrower scope it would win:

- It needs **no JVM** and **no sibling directory** — the Kotlin producer would
  live in `src/` beside the Liquid and Unity producers, in-process and lighter,
  the path this repo prefers when it is viable.
- For the **Compose-only** high-value rules, the analysis is syntactic — find an
  `Image`/`Icon` call with no `contentDescription` argument, climb for a
  `.semantics`/`clearAndSetSemantics` ancestor — which a CST supports under the
  existing conservatism discipline (flag only the high-confidence shape; stay
  opaque otherwise).

It was rejected as **primary** for two reasons that the committed scope makes
decisive: (1) the **programmatic-View surface** benefits from type resolution to
detect absence on a typed receiver, which a CST cannot provide; and (2) Compose's
trailing-lambda / `@Composable` DSL stresses a community grammar where the
*official* compiler frontend is robust — the same reason the Swift engine uses
SwiftSyntax rather than a hand-rolled parser. **It remains the correct fallback**
if the JVM toolchain proves intolerable in CI, or if the programmatic-View surface
is later dropped and Android narrows to Compose-only.

### Reversal

This ADR is the **agent's evidence-based recommendation; the owner (@cansirin)
may override** the Kotlin parser choice toward tree-sitter (option B) — most
plausibly if the JVM/Gradle build proves too heavy for the project's CI budget,
or if a real Kotlin corpus shows the high-value rules are purely syntactic and
type resolution buys nothing. This is **empirically cheap to test before
`kotlin/A11yKotlinScan` commits**, the same A/B the Unity ADR prescribed: take
2–3 real Kotlin apps (a Compose app such as `android/nowinandroid`, plus one
programmatic-View app), hand-confirm the top findings hold on disk, and A/B *one*
`clickable` chain — does flagging it correctly need the receiver's type
(Analysis API) or does plain syntax suffice (then tree-sitter is in play)? If
overridden, the new `kotlin/` directory and its CI build are not created — the
Kotlin producer moves into `src/` — so a reversal should land before that engine
is built. The XML producer's in-TS placement is unaffected either way.
