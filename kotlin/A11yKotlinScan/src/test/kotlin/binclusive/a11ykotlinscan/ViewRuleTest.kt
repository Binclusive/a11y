package binclusive.a11ykotlinscan

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Rule-level coverage for the programmatic-View rules (ADR 0006, lane 3). The contract:
 * a custom touch listener that never reaches `performClick()` is inoperable for
 * accessibility services; a listener that does call it, or one passed opaquely by
 * reference, is not flagged.
 */
class ViewRuleTest {
    private fun ruleIds(src: String): List<String> =
        scanSource(src, "Test.kt").map { it.ruleId }.sorted()

    @Test
    fun touchListenerWithoutPerformClickIsFlagged() {
        val src = """
            fun wire(view: View) {
                view.setOnTouchListener { v, event ->
                    if (event.action == MotionEvent.ACTION_UP) doThing()
                    true
                }
            }
        """.trimIndent()
        assertTrue(
            ruleIds(src).contains("view/touch-no-performclick"),
            "a touch listener that consumes the gesture without performClick() is inoperable",
        )
    }

    @Test
    fun touchListenerCallingPerformClickIsNotFlagged() {
        val src = """
            fun wire(view: View) {
                view.setOnTouchListener { v, event ->
                    if (event.action == MotionEvent.ACTION_UP) v.performClick()
                    true
                }
            }
        """.trimIndent()
        assertEquals(emptyList(), ruleIds(src), "forwarding to performClick() keeps the view operable")
    }

    @Test
    fun touchListenerByReferenceIsNotFlagged() {
        // Opaque — the listener body is not in view, so we never flag it.
        val src = """
            fun wire(view: View, listener: View.OnTouchListener) {
                view.setOnTouchListener(listener)
            }
        """.trimIndent()
        assertEquals(emptyList(), ruleIds(src), "a by-reference listener is opaque, not a violation")
    }
}
