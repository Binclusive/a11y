package io.binclusive.a11ykotlinscan

import kotlin.system.exitProcess

// A11yKotlinScan <dir>
//
// Thin executable shell: all behavior — file discovery, the PSI parse+walk, and
// the JSON output — lives in the (test-reachable) engine functions. Scans <dir>,
// prints a JSON array of findings to stdout, exits 0 on success (2 on usage
// error). A clean/empty scan prints `[]` and exits 0.
fun main(args: Array<String>) {
    if (args.isEmpty()) {
        System.err.println("usage: A11yKotlinScan <dir>")
        exitProcess(2)
    }
    println(Finding.encodeArray(scanFindings(args[0])))
    exitProcess(0)
}
