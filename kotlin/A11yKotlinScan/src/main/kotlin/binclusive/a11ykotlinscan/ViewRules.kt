package binclusive.a11ykotlinscan

import org.jetbrains.kotlin.psi.KtCallExpression
import org.jetbrains.kotlin.psi.KtExpression
import org.jetbrains.kotlin.psi.KtFile
import org.jetbrains.kotlin.psi.KtTreeVisitorVoid

/**
 * Programmatic Android **View** rules (ADR 0006, lane 3) — imperative Kotlin that
 * configures `View` objects in code, as opposed to Compose (lane 2) or XML layouts
 * (lane 1). Same engine, different rule family, plain PSI (no type resolution — the
 * rules below are syntactic; a future rule that needs a receiver's type is where the
 * Analysis API would enter).
 *
 * Rule — view/touch-no-performclick (WCAG 4.1.2; Android Lint `ClickableViewAccessibility`):
 *   `view.setOnTouchListener { _, _ -> … }` whose body never calls `performClick()`.
 *   TalkBack (and every accessibility service) activates a control via `performClick()`,
 *   NOT a synthesized raw touch — so a custom touch handler that consumes the gesture
 *   without forwarding to `performClick()` makes the control inoperable for those users.
 *   Detected syntactically: the listener is a lambda whose body has no `performClick()`
 *   call. A listener passed as a variable/object (no lambda body in view) is OPAQUE and
 *   left alone — opaque beats wrong.
 */

/** Does any call inside `body` invoke `performClick()` (so the listener forwards to the
 * accessibility-activatable click path)? */
private fun callsPerformClick(body: KtExpression): Boolean {
    var found = false
    body.accept(object : KtTreeVisitorVoid() {
        override fun visitCallExpression(expression: KtCallExpression) {
            super.visitCallExpression(expression)
            if (expression.calleeExpression?.text == "performClick") found = true
        }
    })
    return found
}

fun runViewRules(ktFile: KtFile, source: String, filePath: String): List<Finding> {
    val findings = mutableListOf<Finding>()
    ktFile.accept(object : KtTreeVisitorVoid() {
        override fun visitCallExpression(expression: KtCallExpression) {
            super.visitCallExpression(expression)
            if (expression.calleeExpression?.text != "setOnTouchListener") return
            // Only a trailing-lambda listener is readable. A listener passed by reference
            // (`setOnTouchListener(myListener)`) is opaque — we can't see its body, so we
            // never flag it.
            val body = expression.lambdaArguments.firstOrNull()?.getLambdaExpression()?.bodyExpression
                ?: return
            if (callsPerformClick(body)) return
            findings.add(
                Finding(
                    file = filePath,
                    line = lineAt(source, expression.textOffset),
                    ruleId = "view/touch-no-performclick",
                    message = "setOnTouchListener handles touch but never calls performClick() — " +
                        "accessibility services (TalkBack) activate a view via performClick(), not a raw " +
                        "touch, so this control is inoperable for them. Call view.performClick() when the " +
                        "gesture completes (e.g. on ACTION_UP), or use setOnClickListener.",
                    wcag = listOf("4.1.2"),
                    severity = "serious",
                ),
            )
        }
    })
    return findings
}
