package binclusive.a11ykotlinscan

/**
 * One static accessibility finding — the exact JSON shape the TS side
 * (src/collect-android-kotlin.ts) parses at the process boundary, mirroring
 * swift/A11ySwiftScan's `Finding.swift`:
 *   { file, line, ruleId, message, wcag: ["4.1.2"], severity: "serious"|"critical" }
 *
 * `severity` is "critical" only when the missing name leaves an interactive element
 * with no accessible name at all (unusable by TalkBack), else "serious".
 */
data class Finding(
    val file: String,
    val line: Int,
    val ruleId: String,
    val message: String,
    val wcag: List<String>,
    val severity: String,
)

private fun jsonString(s: String): String {
    val sb = StringBuilder("\"")
    for (c in s) {
        when (c) {
            '\\' -> sb.append("\\\\")
            '"' -> sb.append("\\\"")
            '\n' -> sb.append("\\n")
            '\r' -> sb.append("\\r")
            '\t' -> sb.append("\\t")
            else -> if (c < ' ') sb.append("\\u%04x".format(c.code)) else sb.append(c)
        }
    }
    sb.append("\"")
    return sb.toString()
}

/** Serialize findings as the JSON array the TS collector reads from stdout. Hand-rolled
 * (no kotlinx.serialization dependency) — the shape is small and fixed. */
fun findingsToJson(findings: List<Finding>): String =
    findings.joinToString(separator = ",", prefix = "[", postfix = "]") { f ->
        buildString {
            append("{")
            append("\"file\":").append(jsonString(f.file)).append(",")
            append("\"line\":").append(f.line).append(",")
            append("\"ruleId\":").append(jsonString(f.ruleId)).append(",")
            append("\"message\":").append(jsonString(f.message)).append(",")
            append("\"wcag\":").append(f.wcag.joinToString(",", "[", "]") { jsonString(it) }).append(",")
            append("\"severity\":").append(jsonString(f.severity))
            append("}")
        }
    }
