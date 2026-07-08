import org.jetbrains.kotlin.gradle.dsl.JvmTarget

// The static Jetpack Compose accessibility engine — the Android analog of
// swift/A11ySwiftScan. Parses `.kt` source with the Kotlin compiler's PSI and
// emits a JSON array of findings to stdout. See ADR 0008 for the architecture
// (Compose surface, restart-clean, PSI parser, `compose/` rule prefix).
//
// Version matrix (pinned deliberately — JDK 26 + Gradle 9.6 are bleeding-edge):
//   Kotlin plugin + kotlin-compiler-embeddable = 2.3.21, the exact Kotlin that
//   Gradle 9.6.1 bundles and runs on JDK 26, so the KGP↔Gradle↔JDK combo is
//   known-good. jvmTarget = 21 (a supported, stable bytecode target) is set via
//   compilerOptions rather than jvmToolchain(21): no JDK 21 is installed, so a
//   toolchain would trigger provisioning; targeting 21 from the JDK-26 launcher
//   avoids that and still runs on JDK 26.
plugins {
    kotlin("jvm") version "2.3.21"
    application
}

repositories {
    mavenCentral()
}

dependencies {
    // The Kotlin frontend as an embeddable jar (intellij packages relocated under
    // org.jetbrains.kotlin.*). This is the SwiftSyntax analogue mandated by ADR
    // 0008 fork 3 — a real PSI AST with precise source positions, not regex.
    implementation("org.jetbrains.kotlin:kotlin-compiler-embeddable:2.3.21")

    testImplementation(kotlin("test"))

    // Property-based precision guard (ComposePrecisionPropertyTest, #258 — parity
    // with test/source-trace.pbt.test.ts). kotest-property is a pure generator
    // library: `Arb` + `checkAll` run inside the existing kotlin.test @Test on the
    // JUnit Platform runner already configured below — no second test engine, no
    // new CI workflow. checkAll is a suspend fun, so runBlocking (coroutines-core).
    testImplementation("io.kotest:kotest-property:5.9.1")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.10.2")
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_21
        // KotlinCoreEnvironment (the PSI entry point) is K1-frontend API, which
        // Kotlin 2.3 gates behind an opt-in. PSI parsing is exactly the stable,
        // supported use of it (ADR 0008 fork 3); opt in rather than adopt the
        // heavier Analysis API for a text-parse-and-walk engine.
        optIn.add("org.jetbrains.kotlin.K1Deprecation")
    }
}

java {
    sourceCompatibility = JavaVersion.VERSION_21
    targetCompatibility = JavaVersion.VERSION_21
}

application {
    mainClass = "io.binclusive.a11ykotlinscan.MainKt"
}

tasks.test {
    useJUnitPlatform()
}
