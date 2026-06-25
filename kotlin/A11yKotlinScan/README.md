# A11yKotlinScan

The external **Kotlin/JVM engine** for the Android Compose + programmatic-View
accessibility lanes (ADR 0006) — the Kotlin analog of `swift/A11ySwiftScan`. A thin
CLI over the Kotlin compiler frontend (PSI, `kotlin-compiler-embeddable`) that parses
`.kt` and prints the JSON `Finding` contract on stdout, shelled to from
`src/collect-android-kotlin.ts`.

> **Why a sibling directory, not `src/`?** Node can't run the Kotlin frontend, exactly
> as it can't run SwiftSyntax — so the analysis lives out of process and the TS side is
> a thin spawn-and-parse boundary. (The XML lane, by contrast, parses in-process in
> `src/` because XML is cheap in Node — ADR 0006.)

## Rules (today)

| ruleId | WCAG | what |
|---|---|---|
| `compose/icon-button-no-name` | 4.1.2 | An `IconButton` / `IconToggleButton` / `FilledIconButton` (…) whose content is **provably nameless** — a literal `Icon`/`Image` with `contentDescription = null`, no `Text`, and nothing opaque. |

**Precision (the invariant).** A standalone decorative `Icon(contentDescription = null)`
is never flagged (only icons that are the sole content of an interactive control are),
and a control whose content is a **composable slot** (`icon()`, a `@Composable () -> Unit`
parameter) or a custom composable is treated as **opaque, not nameless** — the name may
be supplied by the caller, invisible to static PSI. Opaque beats wrong. Validated
against Now in Android (310 `.kt`, 0 false positives after the slot fix).

Plain PSI, **no type resolution** — the evidence A/B confirmed the Compose rules are
syntactic (argument names + null-vs-expression + nesting). See
`experiments/android-matrix/COMPOSE-EVIDENCE.md`.

## Build

```
cd kotlin/A11yKotlinScan
./gradlew installDist      # → build/install/A11yKotlinScan/bin/A11yKotlinScan
```

The TS collector (`src/collect-android-kotlin.ts`) runs that installed launcher; if it
is absent it reports the engine as not-built rather than a silent clean scan.

### JDK requirement — build needs 17 ≤ JDK ≤ 23; runtime is any JDK 17+

The bundled Kotlin **2.1.0** *compiler* cannot run on **JDK 24+** — it throws
`IllegalArgumentException` parsing the version string during `compileKotlin`. So the
**build** needs a JDK in `[17, 23]`:

```
export JAVA_HOME="$(/usr/libexec/java_home -v 23)"   # macOS; or any JDK 17–23
./gradlew installDist
```

The **engine at runtime is not affected** — it uses only the frontend's PSI-parse path,
which does not hit that version check. Verified working on **JDK 26**: it emits clean
JSON on stdout (newer JDKs print a `sun.misc.Unsafe` deprecation warning to *stderr* —
harmless; the collector reads stdout only). So `check-android` runs the engine on
whatever JDK is on `PATH`; only rebuilding the engine needs a ≤23 JDK. Lifting the build
ceiling means bumping `kotlin-compiler-embeddable` to a JDK-24+-aware release (tracked
for when the lane hardens).

## Run

```
build/install/A11yKotlinScan/bin/A11yKotlinScan <project-dir>   # JSON Finding[] on stdout
```

## Scope (ADR 0006)

This is **lane 2** — Compose. The programmatic-Kotlin View surface (`imageView.contentDescription = …`,
`setOnClickListener`, custom `View`s) is the same engine, additional rules, and is where
the Analysis API would be adopted *if* a rule needs a receiver's type. Not built yet.
