---
name: compose-a11y
description: Audit a Jetpack Compose / Android app for accessibility — read .kt source for missing content descriptions on Image/Icon (static, runs anywhere), then drive the app with Espresso + Google's Accessibility Test Framework for the issues source can't see (contrast, touch-target size, traits). Every finding carries a WCAG success criterion, a severity, and a concrete Compose fix. Use when the user says "audit my Compose app", "check Android accessibility", "a11y my Android app", "TalkBack audit", "accessibility audit for Android", or points you at a Jetpack Compose codebase and wants accessibility findings. Self-contained — bakes the rules in; needs no Binclusive package on disk.
---

# Jetpack Compose accessibility audit

You audit a Jetpack Compose codebase for accessibility and report findings the way the
Binclusive web tool does: **every finding carries a WCAG success criterion, a severity, and
a concrete fix.** This skill is self-contained — the rules and WCAG knowledge are baked in
below. You need nothing from the `a11y-checker` package; you run inside the customer's repo.

There are **two layers**, mirroring the web tool's static lint + render→axe split (and the
SwiftUI collector's static + runtime split — Compose is the direct Android parallel, ADR
`.decisions/0008-android-collector-compose-scope-engine.md`):

| Layer | What it reads | What it catches | Needs |
|---|---|---|---|
| **1 · STATIC** | `.kt` source | missing `Image`/`Icon` content descriptions — the mechanical shapes | nothing — runs anywhere |
| **2 · RUNTIME** | the app rendered on a device/emulator | contrast, touch-target size, traits, duplicate bounds — what source can't see | Android SDK + emulator, **or** a connected Android automation MCP |

Static is fast and source-grounded. Runtime is where the real coverage lives — exactly
like render→axe vs. static lint on the web. Run **both** when you have the Android toolchain;
run Layer 1 alone anywhere else and say so in the report.

> ### Scope and coverage — read this before reporting "clean"
>
> **The static Compose scan is currently a 1-rule floor, not a full audit.** Layer 1 emits
> exactly one rule — `compose/image-no-label` (WCAG 1.1.1). It is **materially thinner than
> the web/React engine** (which additionally runs a host-element resolver, cross-file wrapper
> resolution, suppression handling, and a corpus-driven WCAG-enrichment pass) and thinner even
> than the 2-rule SwiftUI floor — the Compose engine has **none** of those subsystems yet, and
> its unlabeled-control rule (`compose/control-no-name`, 4.1.2) is **not yet implemented**. So a
> clean static Compose result means **"no missing `Image`/`Icon` content descriptions found by
> the 1-rule floor (plus whatever runtime you ran),"** never **"fully accessible"** — most
> failure modes (contrast, touch-target size, unnamed clickables, headings, color-only state,
> form labels, unresolved custom composables) are simply **not yet checked statically**.
>
> This asymmetry is **a coverage debt being actively closed, not the intended scope.** Per
> **ADR `.decisions/0008-android-collector-compose-scope-engine.md`**, the Compose collector is
> the SwiftUI collector's Android sibling and is on a stated path to parity with the TS engine;
> the Android surface is tracked in **epic #108**, which ships `compose/image-no-label` first and
> leaves the further Compose rules as pickable follow-on children. Until that work lands,
> **always state the floor explicitly in your report** (see "Always end with this report" below)
> so a user never reads a thin static pass as a complete audit.

**Lead with the most impactful failures first.** Across audits, the recurring Compose shapes
are, roughly in order: unlabeled images/icons (1.1.1), icon-only clickables with no name
(4.1.2), color-contrast (1.4.3), and touch targets below the 48dp minimum (2.5.5). Report in
that spirit — most-impactful first — but **invent no frequency numbers.** State what you found;
don't fabricate how common it is.

---

## Layer 1 — STATIC (read the source)

Read the `.kt` files and apply the rule below. This is the precision-floor layer: it catches
the mechanical shape with no emulator. It does **not** catch contrast or touch-target size —
that's Layer 2's job, and you must say so.

### The precision invariant (why the engine stays conservative)

The engine maps to the **correct** conclusion — labeled or unlabeled — **or stays opaque
(unflagged)**; it must **never** mis-flag a control that is in fact labeled. A false positive on
a labeled control is the failure mode that gets an a11y tool uninstalled. So a construct the
engine can't resolve stays **UNFLAGGED**, never wrong-flagged — the same invariant that governs
the resolver and the SwiftUI collector (ADR 0008). When in doubt, the engine stays silent.

### The core heuristic — is a content description already reaching this `Image`/`Icon`?

This is the single most important rule, and it's where naïve scans go wrong. A bare `Image`
or `Icon` is **not** automatically a violation — Compose supplies the accessible name through
`contentDescription`, and it can arrive several ways. Before flagging, check whether a
description **already reaches the call**. It counts as supplied (so the engine **does not flag**)
when any of these hold:

- **A named `contentDescription` argument** — `Image(painter, contentDescription = "Profile
  banner")`. Any value counts as supplied.
- **A 2nd positional argument** — `contentDescription` is the second positional parameter of
  every `Image`/`Icon` overload, so `Icon(Icons.Default.Menu, "Open menu")` supplies it
  positionally. Treating the 2nd positional as the description is what keeps positional call
  sites from mis-flagging.
- **`contentDescription = null`** — the author's **deliberate decorative opt-out** ("this glyph
  carries no semantic value"). An explicit `null` is an intentional decision, not a missing
  label — **don't flag it.**
- **An enclosing `semantics { }` (or `clearAndSetSemantics { }`) block that sets a
  `contentDescription`** — the ancestor's semantics supply the name for the merged element, so
  the inner `Image`/`Icon` is covered. This is the Compose analog of SwiftUI's climb to the
  nearest accessibility-element ancestor.

Only flag the `Image`/`Icon` when, after these checks, **no content description reaches it** —
not on the call (named or positional), not as a decorative `null`, and not from an enclosing
`semantics` block.

### Rule 1 — missing image label (`compose/image-no-label`, WCAG 1.1.1)

An `Image(...)` or `Icon(...)` call with **no** `contentDescription` — not supplied on the call
(named or 2nd positional), not the decorative `null`, and not set by an enclosing `semantics { }`
/ `clearAndSetSemantics { }` block. TalkBack announces nothing for it.

- **Severity:** **serious** normally; **critical** when the unlabeled `Image`/`Icon` sits inside
  an interactive control — a `Button`, `IconButton`, or `FloatingActionButton`, or anything made
  tappable with `.clickable`. An unnamed control is unusable by TalkBack, so an unlabeled icon
  that *is* the tap target is the more urgent failure.
- **Don't flag** (these are intentional or already labeled — the no-flag cases above):
  - `contentDescription = null` — explicitly decorative; the author's deliberate opt-out.
  - `Image(painter, contentDescription = "…")` — a named description of any value.
  - `Icon(imageVector, "Open menu")` — a 2nd-positional description.
  - an `Image`/`Icon` wrapped in a `Modifier.semantics { contentDescription = "…" }` (or
    `clearAndSetSemantics { … }`) ancestor — the ancestor names the merged element.
- Fix — name the **action or content**, not the glyph:
  ```kotlin
  Icon(
      imageVector = Icons.Default.Delete,
      contentDescription = "Delete",   // the action, not "trash"
  )

  Image(
      painter = painterResource(R.drawable.divider),
      contentDescription = null,        // purely decorative — intentional opt-out
  )
  ```

> **Not yet checked statically — `compose/control-no-name` (WCAG 4.1.2).** An icon-only
> `.clickable` composable or custom control whose accessible name is empty is a real failure, but
> the Compose collector **does not yet emit** a `compose/control-no-name` rule (unlike the SwiftUI
> floor, which ships `swiftui/control-no-name`). It is a planned follow-on child under epic #108 —
> until it lands, an unnamed clickable is caught only at runtime (Layer 2), so don't report an
> unnamed non-`Image`/`Icon` control as a *static* finding.

### The opacity problem — resolve custom composables

The same blind spot the web tool's call-site `enforce` pass exists for: an `Image`/`Icon` inside
a **custom composable** (`IconButtonTile`, `AvatarImage`, `CircleIcon`) is invisible to a
single-file scan. You see `AvatarImage(url = …)` at the call site and can't tell whether the
composable labels its inner `Image`.

**Don't guess — resolve it.** Open the composable's definition. Check whether it:
- forwards a `contentDescription` parameter to its inner `Image`/`Icon`, or
- hard-codes a description, or
- leaves the inner `Image`/`Icon` unlabeled (the real bug — every call site inherits it).

If a composable leaves its inner control unlabeled, flag the **composable definition** once (fix
it at the source, every call site benefits) and note which call sites pass no name. If you
genuinely can't see the composable's source (third-party, binary AAR), say so — list it as
"unresolved composable, not checked," the Compose equivalent of the web tool's opaque-component
blind spot. Never claim coverage you don't have.

### Judgment, not filler

Decorative-vs-informative is an **intent** call — a hero photo is informative, a background
texture is decorative. When you can't tell from context, **flag it and note the ambiguity**;
don't silently pass and don't fabricate a description. **Never write filler**: no
`contentDescription = "image"`, `contentDescription = "icon"`, or any placeholder that satisfies
the API while lying to a TalkBack user. A lying description is worse than an open finding — derive
a real name from nearby text / the action / the parameter, or leave it open and list it for a
human. When the glyph is genuinely decorative, the honest fix is `contentDescription = null`, not
a filler string.

---

## Layer 2 — RUNTIME (drive the app, run Google's audit)

This is the higher-signal layer. Static can't see computed color, rendered layout, or the real
accessibility tree — runtime can. It needs the **Android SDK + an emulator/device**, or a
connected **Android automation MCP**. Run it where you have the toolchain; that's where the real
issues (contrast, touch-target size) actually surface.

### Run Google's shipped audit — the Accessibility Test Framework via Espresso

Google ships an accessibility audit (the Accessibility Test Framework, ATF) wired into Espresso
— the "axe-core for Android": you enable it and every Espresso interaction audits the current
screen. Enable it in an instrumented test:

```kotlin
import androidx.test.espresso.accessibility.AccessibilityChecks

class AccessibilityAuditTest {
    init {
        // audits every view interacted with, on every Espresso action
        AccessibilityChecks.enable()
    }
    // drive to the screen you want, then interact — each action runs the ATF checks
}
```

For a Compose screen, drive it with `createAndroidComposeRule` and interact through the semantics
tree (a Compose node is exposed to the Android accessibility tree, so ATF sees it). Audit per
screen you care about — navigate first, then interact, so the check runs against the rendered
view. If a connected Android automation MCP can drive the emulator and surface accessibility
issues, use it the same way: render each screen, collect the issues, map them through the table
below.

### ATF check → WCAG SC (use this mapping in every runtime finding)

ATF reports issues by check; translate each into a WCAG success criterion so runtime findings
read exactly like the web tool's findings.

> **Two severity axes, two surfaces.** The static Rule 1 above carries the engine's *impact*
> severity (`serious`/`critical`, emitted verbatim by the collector); the dynamic ATF checks below
> carry an *enforcement* disposition (`warn`/`block`). Different producers, different axes — don't
> reconcile them into one vocabulary.

| ATF check | WCAG SC | What it means | Severity |
|---|---|---|---|
| **Speakable text (missing content description)** | 1.1.1 / 4.1.2 | element has no accessible name that TalkBack can speak | block |
| **Text contrast** | 1.4.3 | text/background contrast below threshold (the classic source-blind one) | block |
| **Image contrast** | 1.4.11 | non-text/icon contrast below threshold against its background | warn → block |
| **Touch target size** | 2.5.5 | tappable target smaller than the 48×48dp minimum | warn |
| **Duplicate clickable bounds / duplicate speakable text** | 4.1.2 | overlapping tap targets or ambiguous names — control not exposed cleanly | warn |
| **Editable / redundant content description** | 1.1.1 / 4.1.2 | a description on an editable field, or one that restates the role | warn |

Concrete runtime fixes:
```kotlin
// Touch target (2.5.5): give the tappable area at least 48x48dp
IconButton(onClick = { like() }) {                 // IconButton is already >= 48dp
    Icon(Icons.Default.FavoriteBorder, "Like")
}
Box(Modifier.size(48.dp).clickable { open() }) { … }

// Missing speakable text (1.1.1 / 4.1.2): name the action, restore the role
Modifier
    .clickable(onClickLabel = "Open thread") { open() }
    .semantics { role = Role.Button }

// Contrast (1.4.3 / 1.4.11): this is a design-token fix, not an accessibility-API fix —
// raise the foreground/background contrast to >= 4.5:1 (>= 3:1 for large text and icons).
```

### Why runtime is the real coverage

Static is fast and grounded in source you can read, but it is **structurally blind** to contrast
(needs computed colors against rendered layout), touch-target size (needs the laid-out frame),
and duplicate/overlapping bounds (needs the composed tree) — the exact analogue of static JSX
being blind to `color-contrast` on the web. The runtime audit sees the app as a TalkBack user's
device renders it. The two layers are complementary, not equal: static catches a fraction; the
runtime audit is where the high-impact issues live.

---

## Always end with this report

- **Findings** — most-impactful first (unlabeled images/icons → unnamed clickables → contrast →
  touch-target size). Each one line: `File.kt:line` (static) or screen + element (runtime) —
  **WCAG SC**, **severity**, **one-line fix**.
- **Layers run** — say which layers you actually ran. If you ran Layer 1 only (no Android
  toolchain / no Android MCP), say so plainly: "static only — contrast and touch-target size are
  unverified; run Layer 2 on a machine with the Android SDK to cover them."
- **Blind spots** — unresolved custom composables (couldn't read their source), unnamed
  clickables (not yet a static rule — `compose/control-no-name` is unimplemented), and any screen
  you didn't drive on an emulator. List them; never count them as clean.
- **Framing** — "these are the accessibility shapes that recur in Compose apps, each mapped to its
  WCAG success criterion." **Never say the app is now compliant.** You report and remediate
  findings; you do not certify compliance. No accessibility theater — real source changes and a
  real device-rendered audit, verified locally.
