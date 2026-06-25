package binclusive.a11ykotlinscan

import org.jetbrains.kotlin.psi.KtCallExpression
import org.jetbrains.kotlin.psi.KtFile
import org.jetbrains.kotlin.psi.KtLambdaExpression
import org.jetbrains.kotlin.psi.KtTreeVisitorVoid
import org.jetbrains.kotlin.psi.KtValueArgument

/**
 * The Compose static rules — the Kotlin/Jetpack-Compose analog of the SwiftUI engine's
 * rule set and the Android XML lane (ADR 0006).
 *
 * Rule 1 — compose/icon-button-no-name (WCAG 4.1.2):
 *   An icon-button composable (`IconButton`, `IconToggleButton`, `FilledIconButton`, …)
 *   whose content supplies NO accessible name — i.e. its child `Icon`/`Image` all pass
 *   `contentDescription = null` and there is no `Text`. TalkBack announces nothing
 *   actionable. This is the canonical Compose a11y failure, and it is precise: a
 *   standalone decorative `Icon(contentDescription = null)` is NOT flagged (only icons
 *   that are the sole content of an interactive control are), matching the evidence
 *   that `contentDescription = null` is the correct decorative pattern in Compose.
 */

private val ICON_BUTTON_CALLEES = setOf(
    "IconButton",
    "IconToggleButton",
    "FilledIconButton",
    "FilledTonalIconButton",
    "OutlinedIconButton",
    "FilledIconToggleButton",
    "FilledTonalIconToggleButton",
    "OutlinedIconToggleButton",
)

private val IMAGE_CALLEES = setOf("Icon", "Image")

/** Layout composables that are transparent name-wise — they hold content but supply no
 * name themselves, so the climb keeps looking through them rather than treating them as
 * an unknown (opaque) call. */
private val TRANSPARENT_CONTAINERS = setOf(
    "Box", "Row", "Column", "Spacer", "Surface", "BadgedBox", "BoxWithConstraints",
    "CompositionLocalProvider",
)

/** The simple callee name of a call (`IconButton(...)` → "IconButton"); null if the
 * callee is not a bare name reference. */
private fun KtCallExpression.calleeName(): String? = calleeExpression?.text

/** The value argument passed by the given name, or null if it is absent / positional. */
private fun KtCallExpression.namedArg(name: String): KtValueArgument? =
    valueArguments.firstOrNull { it.getArgumentName()?.asName?.asString() == name }

/**
 * The trimmed source text of an `Icon`/`Image` call's `contentDescription`, or null if
 * it has none. Compose's signature is `Icon(source, contentDescription, …)`, so the
 * argument may be NAMED (`contentDescription = …`) or the 2nd POSITIONAL argument
 * (`Icon(Icons.Menu, null)`) — real code uses both, so both must be read or a positional
 * description reads as a false "no name". A 2nd positional is unambiguous: the only other
 * thing it could be is `contentDescription` (a `Modifier` there would not type-check).
 */
private fun contentDescriptionText(call: KtCallExpression): String? {
    call.namedArg("contentDescription")?.getArgumentExpression()?.let { return it.text.trim() }
    val second = call.valueArguments.getOrNull(1) ?: return null
    if (second.getArgumentName() != null) return null // a different named arg, not positional
    return second.getArgumentExpression()?.text?.trim()
}

/** Does this `Icon`/`Image` call carry a non-null `contentDescription` (a real name)? */
private fun imageHasName(call: KtCallExpression): Boolean {
    val text = contentDescriptionText(call) ?: return false
    return text != "null"
}

/** The trailing content lambda of a composable call (`IconButton(onClick) { … }`). */
private fun KtCallExpression.contentLambda(): KtLambdaExpression? =
    lambdaArguments.firstOrNull()?.getLambdaExpression()

/** What a scan of an icon-button's content lambda observed — enough to decide between
 * "provably nameless" (flag) and "named or opaque" (don't). */
private class ContentScan {
    var sawImage = false // a literal Icon/Image call we can read
    var sawNamedImage = false // an Icon/Image with a non-null contentDescription
    var sawText = false // a Text call (an accessible name)
    var sawOpaque = false // a call we can't see into — a composable slot/parameter or a
    // custom composable — whose rendered name is invisible to static PSI.
}

/** Walk the content lambda once, classifying every call. A call that is neither a known
 * leaf (`Icon`/`Image`/`Text`) nor a transparent container is OPAQUE — e.g. `icon()`, a
 * `@Composable () -> Unit` slot supplied by the caller, or a custom composable. We then
 * only flag when the content is PROVABLY nameless, never when it is merely opaque. */
private fun scanContent(lambda: KtLambdaExpression): ContentScan {
    val scan = ContentScan()
    lambda.bodyExpression?.accept(object : KtTreeVisitorVoid() {
        override fun visitCallExpression(expression: KtCallExpression) {
            super.visitCallExpression(expression)
            when (val callee = expression.calleeName()) {
                "Text" -> scan.sawText = true
                in IMAGE_CALLEES -> {
                    scan.sawImage = true
                    if (imageHasName(expression)) scan.sawNamedImage = true
                }
                in TRANSPARENT_CONTAINERS -> {} // keep looking through it
                else -> if (callee != null) scan.sawOpaque = true
            }
        }
    })
    return scan
}

fun runComposeRules(ktFile: KtFile, source: String, filePath: String): List<Finding> {
    val findings = mutableListOf<Finding>()
    ktFile.accept(object : KtTreeVisitorVoid() {
        override fun visitCallExpression(expression: KtCallExpression) {
            super.visitCallExpression(expression)
            if (expression.calleeName() !in ICON_BUTTON_CALLEES) return
            val content = expression.contentLambda() ?: return
            val scan = scanContent(content)
            // Flag ONLY when provably nameless: a real Icon/Image is present, every one
            // is contentDescription=null, there is no Text, and nothing opaque (a slot or
            // custom composable) could be supplying a name out of static view. Opaque
            // beats wrong — a wrapper whose content is `icon()` is left alone.
            val provablyNameless =
                scan.sawImage && !scan.sawNamedImage && !scan.sawText && !scan.sawOpaque
            if (!provablyNameless) return
            findings.add(
                Finding(
                    file = filePath,
                    line = lineAt(source, expression.textOffset),
                    ruleId = "compose/icon-button-no-name",
                    message = "${expression.calleeName()} has no accessible name — its icon content passes " +
                        "contentDescription = null and there is no Text, so TalkBack announces nothing " +
                        "actionable. Give the Icon a contentDescription (the action it performs), or set " +
                        "a name via Modifier.semantics { }.",
                    wcag = listOf("4.1.2"),
                    severity = "critical",
                ),
            )
        }
    })
    return findings
}
