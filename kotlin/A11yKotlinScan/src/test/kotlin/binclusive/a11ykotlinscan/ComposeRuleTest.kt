package binclusive.a11ykotlinscan

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Rule-level coverage for the static Compose engine — parses an inline `.kt` source
 * through [scanSource] and asserts on the rule ids, so the rules are guarded without a
 * Gradle build of the analyzed code. The precision contract: flag an icon-only control
 * ONLY when nothing in its content supplies a name; never a decorative standalone Icon.
 */
class ComposeRuleTest {
    private fun ruleIds(src: String): List<String> =
        scanSource(src, "Test.kt").map { it.ruleId }.sorted()

    @Test
    fun namedIconButtonIsNotFlagged() {
        val src = """
            @Composable fun Bar() {
                IconButton(onClick = { back() }) {
                    Icon(imageVector = Icons.Default.ArrowBack, contentDescription = "Back")
                }
            }
        """.trimIndent()
        assertEquals(emptyList(), ruleIds(src), "a labelled icon button names its control")
    }

    @Test
    fun nullDescriptionIconButtonIsFlagged() {
        val src = """
            @Composable fun Bar() {
                IconButton(onClick = { share() }) {
                    Icon(imageVector = Icons.Default.Share, contentDescription = null)
                }
            }
        """.trimIndent()
        assertTrue(
            ruleIds(src).contains("compose/icon-button-no-name"),
            "an icon button whose only icon is contentDescription=null has no name",
        )
    }

    @Test
    fun decorativeStandaloneIconIsNotFlagged() {
        val src = """
            @Composable fun Bar() {
                Row {
                    Icon(imageVector = Icons.Default.Star, contentDescription = null)
                    Text("Favorites")
                }
            }
        """.trimIndent()
        assertEquals(
            emptyList(),
            ruleIds(src),
            "a decorative Icon outside an interactive control is the correct null pattern",
        )
    }

    @Test
    fun wrapperWithComposableSlotIsNotFlagged() {
        // The Now in Android false positive: a reusable wrapper whose content invokes a
        // `@Composable () -> Unit` slot — the real Icon (and its name) is supplied by the
        // caller, invisible here. Opaque, not nameless → must not flag.
        val src = """
            @Composable
            fun NiaIconToggleButton(
                checked: Boolean,
                icon: @Composable () -> Unit,
                checkedIcon: @Composable () -> Unit,
            ) {
                FilledIconToggleButton(checked = checked, onCheckedChange = {}) {
                    if (checked) checkedIcon() else icon()
                }
            }
        """.trimIndent()
        assertEquals(emptyList(), ruleIds(src), "a composable-slot content is opaque, not nameless")
    }

    @Test
    fun iconButtonWithTextIsNotFlagged() {
        val src = """
            @Composable fun Bar() {
                IconButton(onClick = { ok() }) {
                    Icon(imageVector = Icons.Default.Check, contentDescription = null)
                    Text("OK")
                }
            }
        """.trimIndent()
        assertEquals(emptyList(), ruleIds(src), "a Text child names the control")
    }
}
