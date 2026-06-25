package binclusive.a11ykotlinscan

import java.io.File

/**
 * A11yKotlinScan <dir>
 *
 * Walk a directory for shipped `.kt`, apply the STATIC Compose accessibility rules via
 * the Kotlin PSI frontend, and print a JSON array of findings to stdout. This is the
 * engine the TS `collect-android-kotlin.ts` collector shells to, mirroring how
 * `collect-swift.ts` shells to swift/A11ySwiftScan. No directory → empty scan.
 */
fun main(args: Array<String>) {
    val dir = args.firstOrNull() ?: "."
    val findings = scanDirectory(File(dir))
    println(findingsToJson(findings))
}
