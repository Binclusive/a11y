package binclusive.a11ykotlinscan

import java.io.File
import org.jetbrains.kotlin.com.intellij.openapi.Disposable
import org.jetbrains.kotlin.com.intellij.openapi.util.Disposer
import org.jetbrains.kotlin.cli.common.messages.MessageCollector
import org.jetbrains.kotlin.cli.jvm.compiler.EnvironmentConfigFiles
import org.jetbrains.kotlin.cli.jvm.compiler.KotlinCoreEnvironment
import org.jetbrains.kotlin.config.CommonConfigurationKeys
import org.jetbrains.kotlin.config.CompilerConfiguration
import org.jetbrains.kotlin.psi.KtFile
import org.jetbrains.kotlin.psi.KtPsiFactory

/**
 * The library entry points for the static Compose accessibility engine. `Main.kt` is a
 * thin shell over [scanDirectory]; the test target drives [scanSource] on inline
 * fixtures so the rules are covered without a Gradle build of the analyzed code.
 *
 * Parsing is via the Kotlin compiler frontend's PSI (kotlin-compiler-embeddable) — the
 * Kotlin analog of SwiftSyntax. No type resolution: the Compose rules are syntactic
 * (read argument names + null-vs-expression + nesting), as the evidence A/B confirmed.
 */

/** Directory names that hold tests / build artifacts / generated code — their `.kt`
 * files are not shipped UI, so a finding in one is noise. Mirrors the TS `collectTsx`
 * and the Swift `skipDirs` skip set. */
val skipDirs: Set<String> = setOf(
    "build", ".gradle", ".git", ".idea", "test", "androidTest", "generated",
    "node_modules", "out",
)

/** Is this a test file by name (`FooTest.kt`, `FooKtTest.kt`)? */
fun isTestFile(name: String): Boolean =
    name.endsWith("Test.kt") || name.endsWith("Tests.kt") || name.endsWith("Spec.kt")

fun collectKotlinFiles(root: File): List<String> {
    val out = mutableListOf<String>()
    if (!root.exists()) return out
    root.walkTopDown()
        .onEnter { dir -> dir.name !in skipDirs }
        .forEach { f ->
            if (f.isFile && f.name.endsWith(".kt") && !isTestFile(f.name)) out.add(f.path)
        }
    return out
}

/** A single shared PSI environment for the process. Creating one is non-trivial, so the
 * directory scan reuses it across files; the test target makes one per call. */
private fun createEnvironment(disposable: Disposable): KotlinCoreEnvironment {
    val configuration = CompilerConfiguration().apply {
        put(CommonConfigurationKeys.MESSAGE_COLLECTOR_KEY, MessageCollector.NONE)
        put(CommonConfigurationKeys.MODULE_NAME, "a11y-kotlin-scan")
    }
    return KotlinCoreEnvironment.createForProduction(
        disposable,
        configuration,
        EnvironmentConfigFiles.JVM_CONFIG_FILES,
    )
}

/** Parse one `.kt` source string and apply the static rules. The unit of the test
 * target — `filePath` is only used to stamp findings, the source need not exist on disk. */
fun scanSource(source: String, filePath: String): List<Finding> {
    val disposable = Disposer.newDisposable()
    try {
        val environment = createEnvironment(disposable)
        val ktFile = KtPsiFactory(environment.project).createFile(filePath, source)
        return runComposeRules(ktFile, source, filePath)
    } finally {
        Disposer.dispose(disposable)
    }
}

/** Walk a project dir, parse every shipped `.kt`, and return all findings. The CLI shell. */
fun scanDirectory(root: File): List<Finding> {
    val files = collectKotlinFiles(root)
    if (files.isEmpty()) return emptyList()
    val disposable = Disposer.newDisposable()
    try {
        val environment = createEnvironment(disposable)
        val factory = KtPsiFactory(environment.project)
        val out = mutableListOf<Finding>()
        for (path in files) {
            val source = File(path).readText()
            val ktFile = factory.createFile(path, source)
            out.addAll(runComposeRules(ktFile, source, path))
        }
        return out
    } finally {
        Disposer.dispose(disposable)
    }
}

/** 1-based line number of a PSI text offset within `source`. */
fun lineAt(source: String, offset: Int): Int {
    var line = 1
    val stop = minOf(offset, source.length)
    for (i in 0 until stop) if (source[i] == '\n') line++
    return line
}
