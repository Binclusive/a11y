---
name: swiftui-a11y
description: Audit a SwiftUI / iOS app for accessibility — read .swift source for missing labels and unlabeled controls (static, runs anywhere), then drive the app in the iOS Simulator and run Apple's performAccessibilityAudit() for the issues source can't see (contrast, dynamic type, target size). Every finding carries a WCAG success criterion, a severity, and a concrete SwiftUI fix. Use when the user says "audit my SwiftUI app", "check iOS accessibility", "a11y my Swift app", "VoiceOver audit", "accessibility audit for iOS", or points you at a SwiftUI codebase and wants accessibility findings. Self-contained — bakes the rules in; needs no Binclusive package on disk.
---

# SwiftUI accessibility audit

You audit a SwiftUI codebase for accessibility and report findings the way the Binclusive
web tool does: **every finding carries a WCAG success criterion, a severity, and a concrete
fix.** This skill is self-contained — the rules and WCAG knowledge are baked in below. You
need nothing from the `a11y-checker` package; you run inside the customer's repo.

There are **two layers**, mirroring the web tool's static lint + render→axe split:

| Layer | What it reads | What it catches | Needs |
|---|---|---|---|
| **1 · STATIC** | `.swift` source | missing image labels, unlabeled controls — the mechanical shapes | nothing — runs anywhere |
| **2 · RUNTIME** | the app rendered in the iOS Simulator | contrast, dynamic-type clipping, hit-region size, traits — what source can't see | Xcode + simulator, **or** a connected iOS automation MCP |

Static is fast and source-grounded. Runtime is where the real coverage lives — exactly
like render→axe vs. static lint on the web. Run **both** when you're on a Mac with Xcode;
run Layer 1 alone anywhere else and say so in the report.

**Lead with the most impactful failures first.** Across audits, the recurring SwiftUI
shapes are, roughly in order: unlabeled images/icons (1.1.1), icon-only controls with no
name (4.1.2), color-contrast (1.4.3), and text that clips under large Dynamic Type (1.4.4).
Report in that spirit — most-impactful first — but **invent no frequency numbers.** State
what you found; don't fabricate how common it is.

---

## Layer 1 — STATIC (read the source)

Read the `.swift` files and apply the rules below. This is the precision-floor layer: it
catches mechanical shapes with no simulator. It does **not** catch contrast or dynamic type
— that's Layer 2's job, and you must say so.

### The core heuristic — climb to the nearest accessibility-element ancestor

This is the single most important rule, and it's where naïve scans go wrong. In a spike
against IceCubesApp (7k★, 404 SwiftUI files), **about half** the raw "unlabeled `Image`"
hits were **false positives** — because the label lives on the **enclosing element**, not
the `Image`.

A bare `Image` is not automatically a violation. SwiftUI merges children into one
accessibility element when the parent is itself accessible, and the **parent's** label is
what VoiceOver reads. So before you flag an `Image` as unlabeled, **climb to the nearest
accessibility-element ancestor** and check *there*:

- `Button { … } label: { Image("star") }` — the **Button** is the a11y element. A
  `.accessibilityLabel` on the Button (or text inside it) labels the whole thing. The
  `Image` is **not** unlabeled. **Don't flag.**
- `NavigationLink { Image("avatar") }` — same: the link is the element.
- A `.toolbar { ToolbarItem { Button { Image(…) } } }` item — the toolbar button is the
  element.
- `Image("logo").accessibilityElement(children: .combine)` on an ancestor — children are
  merged; the ancestor's name covers them.

Only flag the `Image` (or control) when, after climbing, **no ancestor up to the nearest
accessibility element supplies a name** and the image is not marked decorative.

### Rule 1 — missing image label (WCAG 1.1.1)

An `Image(...)` that renders informative content, has **no** accessible name on it or any
ancestor up to the nearest a11y element, and is **not** decorative.

- Severity: **block** when the image is the only content of an interactive element or
  conveys information; **warn** when intent is ambiguous.
- **Don't flag** (these are intentional or implicitly labeled):
  - `Image(decorative:)` and `Image(systemName:variableValue:)` marked decorative — explicitly
    "no semantic value." Intentional.
  - any view with `.accessibilityHidden(true)` — intentionally removed from the tree.
  - `Label("Profile", systemImage: "person")` — the **text** is the label; the symbol is
    decorative-by-construction.
  - `Button("Save", systemImage: "checkmark")` and `Button("Save") { … }` — the title
    string is the accessible name.
  - many **SF Symbols** used via `Image(systemName:)` get an implicit VoiceOver name from
    the symbol itself (e.g. `systemName: "trash"` reads "trash"). Treat a bare
    `Image(systemName:)` inside a labeled control as labeled; flag it only when it is the
    sole content of an *unlabeled* interactive element and the symbol's implicit name
    doesn't describe the **action** (a "trash" icon on a delete button should still say
    "Delete", not "trash").
- Fix:
  ```swift
  Image("profile-banner")
      .accessibilityLabel("Your profile banner")   // informative

  Image("divider").accessibilityHidden(true)        // purely decorative
  // or, at construction:
  Image(decorative: "divider")
  ```

### Rule 2 — unlabeled interactive control (WCAG 4.1.2)

An icon-only `Button`, a tappable view (`.onTapGesture`), a `Menu`, or any custom control
whose accessible name, after climbing to the nearest a11y element, is **empty**.

- Severity: **block** — a control with no name is unusable by VoiceOver.
- Common shape: `Button { action() } label: { Image(systemName: "ellipsis") }` with no
  label — VoiceOver announces nothing useful.
- Fix — name the **action**, not the icon:
  ```swift
  Button { showOptions() } label: {
      Image(systemName: "ellipsis")
  }
  .accessibilityLabel("More options")
  ```
  For a tappable non-button view, also restore the role:
  ```swift
  HStack { … }
      .onTapGesture { open() }
      .accessibilityElement(children: .combine)
      .accessibilityLabel("Open thread")
      .accessibilityAddTraits(.isButton)
  ```

### The opacity problem — resolve custom wrappers

The same blind spot the web tool's call-site `enforce` pass exists for: an `Image` inside a
**custom wrapper** (`IconButton`, `AvatarView`, `CircleIconButton`) is invisible to a
single-file scan. You see `IconButton(icon: "heart")` at the call site and can't tell
whether the wrapper labels its image.

**Don't guess — resolve it.** Open the wrapper's definition. Check whether it:
- forwards an `accessibilityLabel` parameter to its inner control, or
- hard-codes a label, or
- leaves the inner `Image` unlabeled (the real bug — every call site inherits it).

If a wrapper leaves its inner control unlabeled, flag the **wrapper definition** once (fix
it at the source, every call site benefits) and note which call sites pass no name. If you
genuinely can't see the wrapper's source (third-party, binary), say so — list it as
"unresolved wrapper, not checked," the SwiftUI equivalent of the web tool's opaque-component
blind spot. Never claim coverage you don't have.

### Judgment, not filler

Decorative-vs-informative is an **intent** call — a hero photo is informative, a
background gradient is decorative. When you can't tell from context, **warn**, don't
silently pass and don't fabricate a label. **Never write filler**: no
`.accessibilityLabel("image")`, `.accessibilityLabel("button")`, or any placeholder that
satisfies the API while lying to a VoiceOver user. A lying label is worse than an open
finding — derive a real name from nearby text / the action / the prop, or leave it open and
list it for a human.

---

## Layer 2 — RUNTIME (drive the app, run Apple's audit)

This is the higher-signal layer. Static can't see computed color, rendered layout, or the
real accessibility tree — runtime can. It needs **Xcode + the iOS Simulator**, or a
connected **iOS automation MCP**. Run it on a Mac with Xcode; that's where the real issues
(contrast, dynamic type) actually surface.

### Run Apple's shipped audit — `performAccessibilityAudit()`

Apple ships an accessibility audit in XCUITest (Xcode 15+ / iOS 17+). It is the
"axe-core for SwiftUI": you launch the app in the simulator and call it on a rendered
screen. Add a UI test:

```swift
import XCTest

final class AccessibilityAuditTests: XCTestCase {
    func testFeedScreen() throws {
        let app = XCUIApplication()
        app.launch()
        // navigate to the screen you want to audit, then:
        try app.performAccessibilityAudit()   // throws on each issue found
        // scope it if you want only specific categories:
        // try app.performAccessibilityAudit(for: [.contrast, .dynamicType, .hitRegion])
    }
}
```

Run it per screen you care about — `performAccessibilityAudit` audits the **current**
rendered view, so navigate first, then audit. If a connected iOS automation MCP can drive
the simulator and surface accessibility issues, use it the same way: render each screen,
collect the issues, map them through the table below.

### Apple audit category → WCAG SC (use this mapping in every runtime finding)

Apple reports issues by category; translate each into a WCAG success criterion so runtime
findings read exactly like the web tool's findings.

| Apple audit category | WCAG SC | What it means | Severity |
|---|---|---|---|
| **Insufficient element description** | 1.1.1 / 4.1.2 | element has no accessible label / name | block |
| **Contrast** | 1.4.3 | text/background contrast below threshold (the classic source-blind one) | block |
| **Dynamic Type / clipped text** | 1.4.4 | text doesn't scale, or clips/truncates at large accessibility sizes | warn → block |
| **Hit region / target size** | 2.5.5 | tap target smaller than the ~44×44pt minimum | warn |
| **Trait** (e.g. element should be a button) | 4.1.2 | wrong/missing trait — control not exposed with the right role | block |

Concrete runtime fixes:
```swift
// Dynamic Type (1.4.4): use text styles, allow scaling, don't hard-cap line count
Text(post.body).font(.body)            // scales with Dynamic Type
    .fixedSize(horizontal: false, vertical: true)   // wrap, don't clip

// Contrast (1.4.3): this is a design-token fix, not an accessibility-API fix —
// raise the foreground/background contrast to ≥4.5:1 (≥3:1 for large text).

// Target size (2.5.5): ensure ≥44×44pt tappable area
Button { … } label: { Image(systemName: "heart") }
    .frame(minWidth: 44, minHeight: 44)

// Missing description / trait (1.1.1 / 4.1.2): label + restore role
.accessibilityLabel("Like").accessibilityAddTraits(.isButton)
```

### Why runtime is the real coverage

Static is fast and grounded in source you can read, but it is **structurally blind** to
contrast (needs computed colors against rendered layout), Dynamic Type clipping (needs the
view painted at an accessibility text size), and target size (needs the laid-out frame) —
the exact analogue of static JSX being blind to `color-contrast` on the web. The runtime
audit sees the app as a VoiceOver user's device renders it. The two layers are
complementary, not equal: static catches a fraction; the runtime audit is where the high-impact
issues live.

---

## Always end with this report

- **Findings** — most-impactful first (unlabeled images/icons → unlabeled controls →
  contrast → Dynamic Type). Each one line: `File.swift:line` (static) or screen + element
  (runtime) — **WCAG SC**, **severity**, **one-line fix**.
- **Layers run** — say which layers you actually ran. If you ran Layer 1 only (no Xcode /
  no iOS MCP), say so plainly: "static only — contrast and Dynamic Type are unverified; run
  Layer 2 on a Mac with Xcode to cover them."
- **Blind spots** — unresolved custom wrappers (couldn't read their source) and any screen
  you didn't drive in the simulator. List them; never count them as clean.
- **Framing** — "these are the accessibility shapes that recur in SwiftUI apps, each mapped
  to its WCAG success criterion." **Never say the app is now compliant.** You report and
  remediate findings; you do not certify compliance. No accessibility theater — real source
  changes and a real device-rendered audit, verified locally.
