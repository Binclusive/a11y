# Android a11y — roadmap & remaining work

The standing record of what the Android accessibility support **is** today and what is
**left**, so the gap between "engines built" and "users get Android a11y checking in the
product" is explicit and reviewable. Companion to the architecture decision
[`.decisions/0006-android-three-surfaces-two-engines.md`](../.decisions/0006-android-three-surfaces-two-engines.md);
for measured results see [`experiments/android-matrix/`](../experiments/android-matrix/).

> One-line status: **Android is a working `check-android` CLI verb with three lanes
> validated against five real apps — and it is wired into *none* of the product/agent
> surfaces yet.** That last clause is the headline of this document.

---

## What's shipped (the four-PR stack)

ADR 0006 carves Android into **three surfaces, two engines**: an in-TS XML-layout
producer (lane 1) and an external Kotlin/JVM engine covering Compose (lane 2) and
programmatic Views (lane 3).

```
main
└─ #100  XML lane (producer + ADR 0006)
   ├─ #101  Compose engine (Kotlin/JVM)
   │  └─ #102  programmatic View lane
   └─ #103  XML-lane regression gate
```

| PR | Lane / piece | Rules | Real-app validation |
|---|---|---|---|
| #100 | XML layouts (`src/collect-android-xml.ts`) | `image-no-label`, `control-no-name`, `editable-no-label` | NewPipe 27 / AntennaPod 35 (3 FP classes found & fixed) |
| #101 | Compose (`kotlin/A11yKotlinScan`) | `compose/icon-button-no-name` | NiA 0 / Seal 2 / ReadYou 1 — 3/3 TP |
| #102 | programmatic Views | `view/touch-no-performclick` | NewPipe 1/1 TP (surface is thin) |
| #103 | XML regression gate | — | baseline locks NewPipe + AntennaPod; drift-tested |

Merge order: **#100 → {#101, #103} → #102**, rebasing each onto `main` as the one below
lands.

---

## What's left

Ordered by what unblocks the most. Each item names its real blocker honestly.

### Tier 1 — Land what's built

- **Merge the stack** in the order above; rebase the stacked branches as `main` moves.
- **CI for the JVM engine — the real blocker for #101/#102.** CI today runs
  `pnpm typecheck` + `pnpm test` + `matrix:check`; it knows nothing about Gradle. The
  Compose/View lanes need a JDK 17–23 + Gradle step that runs `./gradlew build` (the 10
  Kotlin unit tests) and `./gradlew installDist` (so `check-android`'s Compose lane runs
  end-to-end). Without it CI still *passes* — the lane is guarded and degrades to
  XML-only — but the Compose path is never exercised. Silent blind spot, not a failure.

### Tier 2 — Gate the Kotlin lanes

The android-matrix gate (#103) covers **only the XML lane**. Compose (#101) and View
(#102) have **no regression gate** — their safety net is the Kotlin unit tests plus the
*manual* corpus runs recorded in
[`experiments/android-matrix/COMPOSE-EVIDENCE.md`](../experiments/android-matrix/COMPOSE-EVIDENCE.md).
Building a Kotlin/Compose matrix (pin NiA/Seal/ReadYou, bless a baseline, diff on drift)
is straightforward **except** it needs the JVM engine built in CI — blocked on Tier 1.

### Tier 3 — Product-surface integration (the biggest conceptual gap)

`ecosystem.md` frames the product as *"the accessibility layer that travels with the
code… surfaced at every latency from the keystroke to the shipped audit."* Android is
currently reachable **only** via the raw `check-android` CLI verb — it has 0 mentions in
every other surface:

- **MCP tool (`check_android`)** — `src/mcp.ts` exposes `check_a11y` / `check_url` / … and
  Unity got its own `check_unity` tool (#94). Android has none, so no agent/IDE can
  invoke it through MCP.
- **Edit-time hook** — `src/hook.ts` fires on `.tsx` (React) and `.prefab`/`.unity`
  (Unity) edits. It does **not** fire on `.xml` layouts or `.kt` files — no unasked
  Android whisper on edit.
- **`detect-stack.ts` / `init`** — detects framework/router/design-system from
  `package.json`. An Android project has **no `package.json`** (Gradle +
  `AndroidManifest.xml`), so `init` can't recognize it or scaffold a `binclusive.json`.
- **AGENTS/CLAUDE block** (`src/agents-block.ts`) — generates no Android guidance for the
  AI before it writes code.
- **The three skills** (`map-project`, `audit-accessibility`, `fix-accessibility`) — their
  triggers cover React/Next/ASP.NET/ASPX/SwiftUI/UIKit; **Android is absent**. Highest
  leverage here, since the skills are how the product is actually driven.

None of this is individually hard — it is the "wire the new producer into every surface"
work Unity received and Android has not.

### Tier 4 — Rule breadth (every lane is thin)

| Lane | Rules today | Obvious next rules |
|---|---|---|
| XML | 3 | touch-target < 48dp, color-only state, duplicate `id`, redundant `contentDescription` |
| Compose | 1 | `Modifier.clickable` without a name, standalone informative `Image`, `TextField` without label |
| View | 1 | the `onTouchEvent` override variant; the type-resolution rules (Tier 5) |

Android Lint ships ~30 accessibility checks; we have 5. The five are the
high-frequency, high-precision floor — a deliberate floor, not coverage.

### Tier 5 — The Analysis API lift (lane 3's real value)

The highest-value programmatic-View rule — *"an `ImageView` configured in code that never
gets a `contentDescription`"* — needs **type resolution** (is this receiver an
`ImageView`?), i.e. the **Kotlin Analysis API**, i.e. feeding the engine the analyzed
project's full classpath (Android SDK + AndroidX). That is a much heavier engine, closer
to running part of the Gradle build. ADR 0006 deferred it until the surface earns it; the
real-corpus data (`setOnTouchListener` in 1 of 5 apps) says it should wait. A genuinely
large lift — do not start speculatively.

### Tier 6 — Java (the invisible half of legacy Android)

Legacy Android Views are very often **Java**, and the Kotlin frontend **cannot parse
Java** — so a large chunk of real-world Android UI is invisible to the engine. Covering it
means a JavaParser pass (a sibling in the same JVM engine). Out of scope so far (the
committed scope was Kotlin), but a real coverage hole worth naming. Also large.

### Tier 7 — Toolchain & docs hygiene

- **JDK ceiling:** the build needs JDK 17–23 — Kotlin 2.1's compiler can't *run* on JDK
  24+ (`IllegalArgumentException` parsing the version). The runtime is fine on any JDK
  17+. Lifting the build ceiling means bumping `kotlin-compiler-embeddable` to a
  JDK-24+-aware release.
- **`docs/ARCHITECTURE.md` is stale:** it is "code-derivable, update §2/§3 when the layout
  changes," and the Android lanes (3 producers + the `kotlin/` engine) are not reflected
  there. Same for `docs/ecosystem.md` (the strategic frame has no mobile/Android line).

### Tier 8 — Housekeeping

- **`pnpm-workspace.yaml`** — the `allowBuilds` placeholder keeps regenerating and blocks
  `pnpm` scripts until its `true/false` values are filled.
- Stray Gradle build cache (`kotlin/A11yKotlinScan/.gradle` + `build`) shows as untracked
  on branches that lack the engine's nested `.gitignore` (resolves once #101 merges to
  `main`).

---

## Recommended order

For **"Android a11y people actually use"**: **Tier 1 (land it) → Tier 3 (skills + MCP, so
it's reachable in the product) → Tier 2 (gate the Kotlin lanes).** Tiers 4–6 are depth to
add once the surface is in users' hands. Tiers 5 (Analysis API) and 6 (Java) are the two
large lifts and should be demand-driven, not speculative.

*Maintenance: update this file as tiers are completed; delete a tier when it lands and
note the PR. When all of Tiers 1–3 are done, Android has reached parity with the Unity
lane's product integration.*
