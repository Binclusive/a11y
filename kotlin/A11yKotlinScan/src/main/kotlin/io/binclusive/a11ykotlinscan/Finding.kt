package io.binclusive.a11ykotlinscan

/**
 * A single static accessibility finding. The shape is the engine↔TS contract:
 * each item serializes to EXACTLY the JSON object the TS Compose boundary parses,
 * mirroring the Swift engine's `Finding.swift`:
 *
 *     { "file": string, "line": number,
 *       "ruleId": "compose/image-no-label",
 *       "message": string, "wcag": ["1.1.1"], "severity": "serious" | "critical" }
 *
 * `wcag` is a list (always one element here) to match the web tool's
 * `Finding.wcag: readonly string[]`. `severity` is "critical" only when the
 * missing name leaves an interactive element (an IconButton / clickable) with no
 * accessible name at all, else "serious".
 */
data class Finding(
    val file: String,
    val line: Int,
    val ruleId: String,
    val message: String,
    val wcag: List<String>,
    val severity: String,
) {
    /**
     * Serialize the array of findings to the contract JSON. Hand-rolled (no
     * kotlinx.serialization) to keep the dependency graph to just the compiler —
     * one fewer version-matrix coupling on a bleeding-edge JDK/Gradle. Keys are
     * emitted sorted to mirror the Swift engine's `sortedKeys` output.
     */
    companion object {
        fun encodeArray(findings: List<Finding>): String {
            if (findings.isEmpty()) return "[]"
            return findings.joinToString(prefix = "[\n", separator = ",\n", postfix = "\n]") { it.toJsonObject() }
        }
    }

    private fun toJsonObject(): String = buildString {
        append("  {\n")
        append("    \"file\": ").append(jsonString(file)).append(",\n")
        append("    \"line\": ").append(line).append(",\n")
        append("    \"message\": ").append(jsonString(message)).append(",\n")
        append("    \"ruleId\": ").append(jsonString(ruleId)).append(",\n")
        append("    \"severity\": ").append(jsonString(severity)).append(",\n")
        append("    \"wcag\": ").append(wcag.joinToString(prefix = "[", separator = ", ", postfix = "]") { jsonString(it) }).append("\n")
        append("  }")
    }
}

/** Minimal RFC 8259 string escaping for the contract's string fields. */
internal fun jsonString(s: String): String = buildString {
    append('"')
    for (c in s) {
        when (c) {
            '"' -> append("\\\"")
            '\\' -> append("\\\\")
            '\n' -> append("\\n")
            '\r' -> append("\\r")
            '\t' -> append("\\t")
            else -> if (c < ' ') append("\\u%04x".format(c.code)) else append(c)
        }
    }
    append('"')
}
