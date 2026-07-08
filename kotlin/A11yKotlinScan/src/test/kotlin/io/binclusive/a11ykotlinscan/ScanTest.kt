package io.binclusive.a11ykotlinscan

import java.io.File
import kotlin.test.Test
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Exercises the PSI scan against fixture `.kt` files with known expected
 * findings — the Kotlin-side equivalent of the Swift engine's ScanTests. The two
 * fixtures pin both halves of the precision invariant: a positive case must
 * produce exactly one compose/image-no-label finding, and a negative case (every
 * Image/Icon named or decorative) must produce NONE (no false positive).
 *
 * The fixtures live under `src/test/resources/fixtures/` so they are PARSED as
 * source text by the engine, never compiled into the test module — the Swift
 * `exclude: ["Fixtures"]` analogue.
 */
class ScanTest {
    private fun fixturesDir(): File {
        val url = requireNotNull(javaClass.classLoader.getResource("fixtures")) {
            "fixtures resource dir not on the test classpath"
        }
        return File(url.toURI())
    }

    private fun scan(fixture: String): List<Finding> {
        val file = File(fixturesDir(), fixture)
        return KotlinPsi().use { psi -> scanSource(psi, file.readText(), file.path) }
    }

    @Test
    fun positiveFixtureFlagsTheUnlabeledImage() {
        val findings = scan("MissingContentDescription.kt")
        assertEquals(
            1, findings.size,
            "the positive fixture must produce exactly one finding; got ${findings.map { it.ruleId }}",
        )
        val f = findings.single()
        assertEquals("compose/image-no-label", f.ruleId)
        assertEquals(listOf("1.1.1"), f.wcag)
        assertEquals("serious", f.severity)
        assertTrue(f.file.endsWith("MissingContentDescription.kt"))
    }

    @Test
    fun negativeFixtureProducesNoFindings() {
        val findings = scan("LabeledImage.kt")
        assertTrue(
            findings.isEmpty(),
            "labeled/decorative controls must not be flagged — false positive(s): ${findings.map { it.ruleId }}",
        )
    }

    @Test
    fun directoryScanSurfacesOnlyThePositiveFinding() {
        val findings = scanFindings(fixturesDir().path)
        assertEquals(
            1, findings.size,
            "scanning the fixtures dir should surface exactly the one MissingContentDescription finding; got ${findings.map { it.ruleId }}",
        )
        val stable = findings.zipWithNext().all { (a, b) -> a.file <= b.file }
        assertTrue(stable, "findings must be returned in stable (file, line) order")
    }

    @Test
    fun emitsTheFindingJsonContractFieldForField() {
        val json = Finding.encodeArray(scan("MissingContentDescription.kt"))
        assertContains(json, "\"ruleId\": \"compose/image-no-label\"")
        assertContains(json, "\"wcag\": [\"1.1.1\"]")
        assertContains(json, "\"severity\": \"serious\"")
        assertContains(json, "\"file\":")
        assertContains(json, "\"line\":")
        assertContains(json, "\"message\":")
    }

    @Test
    fun cleanScanEncodesAsEmptyArray() {
        assertEquals("[]", Finding.encodeArray(emptyList()))
    }
}
