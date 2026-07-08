package io.binclusive.a11ykotlinscan

import io.kotest.property.Arb
import io.kotest.property.arbitrary.arbitrary
import io.kotest.property.arbitrary.enum
import io.kotest.property.arbitrary.filter
import io.kotest.property.arbitrary.int
import io.kotest.property.checkAll
import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Property-based guard for the compose/image-no-label climb — the Kotlin-engine
 * mirror of `test/source-trace.pbt.test.ts`. The precision invariant is identical
 * across both engines (ADR 0008): map a control to the correct host/severity or
 * stay OPAQUE, NEVER mis-flag. Fixture tests (`ScanTest.kt`) pin enumerated cases;
 * this test EXPLORES the generated-input space so a wrong-host / false-positive
 * regression can't hide between the named fixtures.
 *
 * We synthesize one Compose control per snippet with a KNOWN ground truth — is it
 * accessibly named, and is it interactive — vary how the name is (or isn't)
 * supplied and how the control is wrapped, run the real `scanSource` climb, and
 * assert two properties (so a degenerate "never flag" engine can't pass P1 alone):
 *
 *   P1 Soundness    — a NAMED / decorative control is NEVER flagged (no false
 *                     positive, the failure mode that gets an a11y tool
 *                     uninstalled), and every finding that IS emitted carries the
 *                     correct severity tier (critical iff the control is
 *                     interactive). This is the "never the wrong host" half.
 *   P2 Completeness — a genuinely UNLABELED informative control IS flagged,
 *                     exactly once. This is the anti-degenerate half.
 *
 * EXTENDING THIS GENERATOR: every new Compose rule / climb capability must widen
 * [ComposeSnippet] and [renderSnippet] so the new shape is explored here — mirror
 * CLAUDE.md's "extend its generators when you add resolver capability". Add a new
 * [Label] or [Interactivity] variant (or a new control in [Control]) plus its
 * ground-truth mapping in [ComposeSnippet.labeled] / [ComposeSnippet.expectedSeverity],
 * and the property fleet covers it automatically. Keep every generated shape
 * SYNTACTICALLY valid Kotlin the PSI parser accepts — this is the hard part the
 * TS PBT is spared (it generates wrapper structures, not raw source).
 */
class ComposePrecisionPropertyTest {

    // --- The generated model --------------------------------------------------

    /** The flagged composables the engine reasons about (COMPOSABLES in ComposeScan). */
    enum class Control { IMAGE, ICON }

    /**
     * How (or whether) an accessible name reaches the control. Every variant but
     * [UNLABELED] is a distinct valid seam by which a name is supplied, so each
     * must leave the control OPAQUE (no finding).
     */
    enum class Label {
        UNLABELED, // informative control, no name anywhere -> must be flagged
        NAMED_TEXT, // contentDescription = "…"
        NAMED_NULL, // contentDescription = null (documented decorative marker)
        POSITIONAL, // the 2nd positional argument IS contentDescription
        SEMANTICS_SETS, // enclosing semantics {} assigns contentDescription
        SEMANTICS_CLEAR_SET, // clearAndSetSemantics {} with this.contentDescription =
    }

    /**
     * The interactive context that decides the severity tier. [NONE] -> serious;
     * everything else -> critical (an unnamed *interactive* control is worse). The
     * two shapes the climb resolves differently: an ancestor interactive CALL
     * (IconButton/…) vs. a container carrying an interactive `Modifier` chain.
     */
    enum class Interactivity {
        NONE,
        ICON_BUTTON,
        BUTTON,
        FAB,
        MOD_CLICKABLE,
        MOD_COMBINED_CLICKABLE,
        MOD_SELECTABLE,
        MOD_TOGGLEABLE,
    }

    /** Non-interactive layout wrappers used only to vary nesting depth. */
    enum class Container { COLUMN, ROW, BOX }

    data class ComposeSnippet(
        val control: Control,
        val label: Label,
        val interactivity: Interactivity,
        val depth: Int,
        val container: Container,
    ) {
        /** Ground truth: does an accessible name reach the control -> stays opaque. */
        val labeled: Boolean get() = label != Label.UNLABELED

        /** Ground-truth severity when (and only when) the control IS flagged. */
        val expectedSeverity: String
            get() = if (interactivity == Interactivity.NONE) "serious" else "critical"

        val describe: String get() = "control=$control label=$label interactivity=$interactivity depth=$depth container=$container"
    }

    // --- The generator (an Arb over valid Compose source) ---------------------

    private val snippetArb: Arb<ComposeSnippet> = arbitrary {
        ComposeSnippet(
            control = Arb.enum<Control>().bind(),
            label = Arb.enum<Label>().bind(),
            interactivity = Arb.enum<Interactivity>().bind(),
            depth = Arb.int(0..2).bind(),
            container = Arb.enum<Container>().bind(),
        )
    }

    private fun unlabeledControl(control: Control): String = when (control) {
        Control.IMAGE -> "Image(painterResource(id = R.drawable.icon))"
        Control.ICON -> "Icon(Icons.Default.Add)"
    }

    /** The leaf control with its label seam applied (still valid Kotlin source). */
    private fun renderControl(s: ComposeSnippet): String = when (s.label) {
        Label.UNLABELED -> unlabeledControl(s.control)
        Label.NAMED_TEXT -> when (s.control) {
            Control.IMAGE -> "Image(painter = painterResource(id = R.drawable.icon), contentDescription = \"User avatar\")"
            Control.ICON -> "Icon(Icons.Default.Add, contentDescription = \"Share profile\")"
        }
        Label.NAMED_NULL -> when (s.control) {
            Control.IMAGE -> "Image(painter = painterResource(id = R.drawable.divider), contentDescription = null)"
            Control.ICON -> "Icon(Icons.Default.Add, contentDescription = null)"
        }
        Label.POSITIONAL -> when (s.control) {
            Control.IMAGE -> "Image(painterResource(id = R.drawable.icon), \"User avatar\")"
            Control.ICON -> "Icon(Icons.Default.Add, \"Share profile\")"
        }
        Label.SEMANTICS_SETS ->
            "Modifier.semantics {\n" +
                "    contentDescription = \"User avatar\"\n" +
                "    ${unlabeledControl(s.control)}\n" +
                "}"
        Label.SEMANTICS_CLEAR_SET ->
            "Modifier.clearAndSetSemantics {\n" +
                "    this.contentDescription = \"User avatar\"\n" +
                "    ${unlabeledControl(s.control)}\n" +
                "}"
    }

    /** Wrap [inner] in the interactive context (an ancestor call or a Modifier chain). */
    private fun renderInteractive(s: ComposeSnippet, inner: String): String = when (s.interactivity) {
        Interactivity.NONE -> inner
        Interactivity.ICON_BUTTON -> "IconButton(onClick = { }) {\n$inner\n}"
        Interactivity.BUTTON -> "Button(onClick = { }) {\n$inner\n}"
        Interactivity.FAB -> "FloatingActionButton(onClick = { }) {\n$inner\n}"
        Interactivity.MOD_CLICKABLE -> "Box(modifier = Modifier.clickable { }) {\n$inner\n}"
        Interactivity.MOD_COMBINED_CLICKABLE -> "Box(modifier = Modifier.combinedClickable { }) {\n$inner\n}"
        Interactivity.MOD_SELECTABLE -> "Box(modifier = Modifier.selectable(false) { }) {\n$inner\n}"
        Interactivity.MOD_TOGGLEABLE -> "Box(modifier = Modifier.toggleable(false) { }) {\n$inner\n}"
    }

    private fun renderNesting(s: ComposeSnippet, inner: String): String {
        val open = when (s.container) {
            Container.COLUMN -> "Column {"
            Container.ROW -> "Row {"
            Container.BOX -> "Box {"
        }
        var body = inner
        repeat(s.depth) { body = "$open\n$body\n}" }
        return body
    }

    private fun renderSnippet(s: ComposeSnippet): String {
        val body = renderNesting(s, renderInteractive(s, renderControl(s)))
        return buildString {
            append("package generated\n\n")
            append("import androidx.compose.runtime.Composable\n\n")
            append("@Composable\n")
            append("fun Generated() {\n")
            append(body)
            append("\n}\n")
        }
    }

    private fun KotlinPsi.scan(s: ComposeSnippet): List<Finding> =
        scanSource(this, renderSnippet(s), "Generated.kt")

    // --- The properties -------------------------------------------------------

    // One PSI environment reused across every generated input (KotlinPsi is
    // designed to be created once per run — the parse is re-entrant per file).
    // Block body (not `= runBlocking { … }`): checkAll returns a PropertyContext,
    // and a Jupiter @Test method must return Unit/void or it is silently skipped.
    @Test
    fun p1SoundnessNeverFlagsANamedControlAndTiersCorrectly() {
        runBlocking {
            KotlinPsi().use { psi ->
                checkAll(500, snippetArb) { s ->
                val findings = psi.scan(s).filter { it.ruleId == "compose/image-no-label" }
                if (s.labeled) {
                    assertTrue(
                        findings.isEmpty(),
                        "false positive on a labeled/decorative control (${s.describe}): ${findings.map { it.severity }}",
                    )
                }
                // Wrong-host analogue: any finding that IS emitted must carry the
                // correct severity tier for the generated interactive context.
                    findings.forEach {
                        assertEquals(
                            s.expectedSeverity, it.severity,
                            "wrong severity tier (${s.describe})",
                        )
                    }
                }
            }
        }
    }

    @Test
    fun p2CompletenessUnlabeledControlIsAlwaysFlaggedOnce() {
        runBlocking {
            KotlinPsi().use { psi ->
                checkAll(300, snippetArb.filter { !it.labeled }) { s ->
                    val findings = psi.scan(s).filter { it.ruleId == "compose/image-no-label" }
                    assertEquals(
                        1, findings.size,
                        "an unlabeled control must be flagged exactly once (${s.describe}); got ${findings.size}",
                    )
                    assertEquals(s.expectedSeverity, findings.single().severity, "wrong tier (${s.describe})")
                }
            }
        }
    }
}
