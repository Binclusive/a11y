// A11yKotlinScan — the external Kotlin/JVM engine for the Android Compose +
// programmatic-View a11y lanes (ADR 0006). The Kotlin analog of swift/A11ySwiftScan:
// a thin CLI over the Kotlin compiler frontend (PSI) that prints the JSON `Finding`
// contract on stdout, shelled to from src/collect-android-kotlin.ts.
//
// Plain PSI, no type resolution (Analysis API) — the evidence A/B (Now in Android)
// confirmed the Compose rules are syntactic: read argument names + null-vs-expression
// + structural nesting. See experiments/android-matrix/COMPOSE-EVIDENCE.md.

import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    kotlin("jvm") version "2.1.0"
    application
}

repositories {
    mavenCentral()
}

dependencies {
    // The Kotlin compiler frontend — gives us PSI (KtFile / KtCallExpression / …) to
    // parse .kt without running a build. The same role SwiftSyntax plays for Swift.
    implementation("org.jetbrains.kotlin:kotlin-compiler-embeddable:2.1.0")
    testImplementation(kotlin("test"))
}

application {
    // The thin CLI shell: `A11yKotlinScan <dir>` → JSON findings on stdout.
    mainClass.set("binclusive.a11ykotlinscan.MainKt")
}

tasks.test {
    useJUnitPlatform()
}

// Pin BOTH the Kotlin and Java targets to JVM 17 explicitly, independent of the JDK
// that launches Gradle. Kotlin 2.1 can't target JDK 26 and would fall back to 23 while
// `compileJava` defaults to the running JDK (26), tripping the JVM-target consistency
// check. Fixing both at 17 sidesteps a toolchain Gradle would have to discover/download,
// and the 17-bytecode output runs forward-compatibly on the system JDK (26).
kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

tasks.withType<JavaCompile>().configureEach {
    options.release.set(17)
}
