package io.binclusive.a11ykotlinscan

import org.jetbrains.kotlin.cli.common.messages.MessageCollector
import org.jetbrains.kotlin.cli.jvm.compiler.EnvironmentConfigFiles
import org.jetbrains.kotlin.cli.jvm.compiler.KotlinCoreEnvironment
import org.jetbrains.kotlin.com.intellij.openapi.Disposable
import org.jetbrains.kotlin.com.intellij.openapi.util.Disposer
import org.jetbrains.kotlin.com.intellij.psi.PsiFileFactory
import org.jetbrains.kotlin.config.CommonConfigurationKeys
import org.jetbrains.kotlin.config.CompilerConfiguration
import org.jetbrains.kotlin.idea.KotlinFileType
import org.jetbrains.kotlin.psi.KtFile

/**
 * Owns a headless Kotlin PSI environment and turns `.kt` source text into a
 * `KtFile` AST. This is the SwiftSyntax analogue (ADR 0008 fork 3): a real
 * frontend with precise source positions, so an unresolvable construct can stay
 * opaque rather than be mis-flagged. Created once per run and `close()`d at the
 * end — the environment registers process-wide services, so we reuse one.
 */
class KotlinPsi : AutoCloseable {
    private val disposable: Disposable = Disposer.newDisposable("A11yKotlinScan")
    private val factory: PsiFileFactory

    init {
        val configuration = CompilerConfiguration().apply {
            put(CommonConfigurationKeys.MESSAGE_COLLECTOR_KEY, MessageCollector.NONE)
            put(CommonConfigurationKeys.MODULE_NAME, "a11y-kotlin-scan")
        }
        val env = KotlinCoreEnvironment.createForProduction(
            disposable,
            configuration,
            EnvironmentConfigFiles.JVM_CONFIG_FILES,
        )
        factory = PsiFileFactory.getInstance(env.project)
    }

    fun parse(fileName: String, text: String): KtFile =
        factory.createFileFromText(fileName, KotlinFileType.INSTANCE, text) as KtFile

    override fun close() = Disposer.dispose(disposable)
}
