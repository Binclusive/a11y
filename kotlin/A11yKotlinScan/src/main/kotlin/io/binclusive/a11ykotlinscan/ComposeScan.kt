package io.binclusive.a11ykotlinscan

import org.jetbrains.kotlin.com.intellij.psi.PsiElement
import org.jetbrains.kotlin.psi.KtCallExpression
import org.jetbrains.kotlin.psi.KtFile
import org.jetbrains.kotlin.psi.KtNameReferenceExpression
import org.jetbrains.kotlin.psi.KtTreeVisitorVoid
import org.jetbrains.kotlin.psi.KtValueArgument

/**
 * Rule compose/image-no-label (WCAG 1.1.1): a Compose `Image` / `Icon` call with
 * no `contentDescription` — the direct parallel of swiftui/image-no-label.
 *
 * The precision invariant governs every decision here (ADR 0008): map to the
 * correct host or stay OPAQUE — NEVER mis-flag, because a false positive on a
 * labeled control is the failure mode that gets an a11y tool uninstalled. So an
 * `Image`/`Icon` is flagged ONLY when we are confident no content description
 * reaches it: not on the call, and not supplied by an enclosing `semantics {}`
 * block. When in doubt, we stay silent.
 */
private const val RULE_ID = "compose/image-no-label"
private val COMPOSABLES = setOf("Image", "Icon")
private val SEMANTICS_CALLS = setOf("semantics", "clearAndSetSemantics")
private val INTERACTIVE_CALLS = setOf("IconButton", "Button", "FloatingActionButton")

/** Parse one `.kt` source string and return its findings (the per-file engine). */
fun scanSource(psi: KotlinPsi, source: String, filePath: String): List<Finding> {
    val ktFile = psi.parse(fileNameOf(filePath), source)
    val visitor = ComposeVisitor(filePath, source)
    ktFile.accept(visitor)
    return visitor.findings
}

private fun fileNameOf(path: String): String = path.substringAfterLast('/')

private class ComposeVisitor(val filePath: String, val source: String) : KtTreeVisitorVoid() {
    val findings = mutableListOf<Finding>()

    override fun visitCallExpression(expression: KtCallExpression) {
        val callee = calleeName(expression)
        if (callee in COMPOSABLES && !suppliesContentDescription(expression) && !enclosingSemanticsNamesIt(expression)) {
            val offset = (expression.calleeExpression ?: expression).textOffset
            val interactive = enclosedByInteractiveControl(expression)
            findings.add(
                Finding(
                    file = filePath,
                    line = lineOf(offset),
                    ruleId = RULE_ID,
                    message = "$callee has no contentDescription — TalkBack announces nothing. " +
                        "Add contentDescription = \"…\", or mark it decorative with contentDescription = null.",
                    wcag = listOf("1.1.1"),
                    severity = if (interactive) "critical" else "serious",
                ),
            )
        }
        super.visitCallExpression(expression)
    }

    /**
     * `contentDescription` is the SECOND positional parameter of every `Image`/
     * `Icon` overload, so it is present when either a named `contentDescription`
     * argument exists (any value, including the `null` decorative marker) OR the
     * call passes ≥ 2 positional arguments (the 2nd positional IS it). Treating a
     * positional description as "supplied" is what keeps positional call sites
     * from mis-flagging.
     */
    private fun suppliesContentDescription(call: KtCallExpression): Boolean {
        val args = call.valueArguments
        if (args.any { it.namedContentDescription() }) return true
        val positional = args.count { it.getArgumentName() == null && !it.isSpread }
        return positional >= 2
    }

    private fun KtValueArgument.namedContentDescription(): Boolean =
        getArgumentName()?.asName?.identifier == "contentDescription"

    /** An enclosing `semantics {}` / `clearAndSetSemantics {}` that sets a contentDescription. */
    private fun enclosingSemanticsNamesIt(element: PsiElement): Boolean =
        element.ancestorCalls().any { it.name in SEMANTICS_CALLS && it.call.text.contains("contentDescription") }

    private fun enclosedByInteractiveControl(element: PsiElement): Boolean =
        element.ancestorCalls().any { it.name in INTERACTIVE_CALLS || it.name == "clickable" }

    private fun lineOf(offset: Int): Int {
        var line = 1
        var i = 0
        val end = minOf(offset, source.length)
        while (i < end) {
            if (source[i] == '\n') line++
            i++
        }
        return line
    }
}

private data class NamedCall(val name: String?, val call: KtCallExpression)

/** Walk the PSI parent chain, yielding each enclosing call expression + its callee name. */
private fun PsiElement.ancestorCalls(): Sequence<NamedCall> = sequence {
    var p: PsiElement? = parent
    while (p != null) {
        if (p is KtCallExpression) yield(NamedCall(calleeName(p), p))
        p = p.parent
    }
}

private fun calleeName(call: KtCallExpression): String? =
    (call.calleeExpression as? KtNameReferenceExpression)?.getReferencedName()

/** Discover every shippable `.kt` file under [root] and scan each, in stable (file, line) order. */
fun scanFindings(root: String): List<Finding> {
    KotlinPsi().use { psi ->
        val findings = collectKotlinFiles(root).flatMap { path ->
            val text = runCatching { java.io.File(path).readText() }.getOrNull() ?: return@flatMap emptyList()
            scanSource(psi, text, path)
        }
        return findings.sortedWith(compareBy({ it.file }, { it.line }))
    }
}

private val SKIP_DIRS = setOf("build", ".gradle", ".git", ".kotlin", "test", "androidTest")

private fun collectKotlinFiles(root: String): List<String> {
    val base = java.io.File(root)
    if (!base.exists()) return emptyList()
    return base.walkTopDown()
        .onEnter { it.name !in SKIP_DIRS }
        .filter { it.isFile && it.extension == "kt" }
        .map { it.path }
        .sorted()
        .toList()
}
