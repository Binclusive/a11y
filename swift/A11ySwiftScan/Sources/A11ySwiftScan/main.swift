import Foundation
import A11ySwiftScanCore

// A11ySwiftScan <dir>
//
// Recursively parses every `.swift` file under <dir> (skipping test/build dirs),
// applies the two STATIC SwiftUI accessibility rules with the ancestor-climb
// heuristic, and prints a JSON array of findings to stdout. This is the engine
// the TS `scanSwift` collector (src/collect-swift.ts) shells to, mirroring how
// `scanUrl` shells to the external DOM engine. All the analysis lives in
// `A11ySwiftScanCore` so the rule logic is unit-testable; this file is the thin
// CLI shell over `scanDirectory`.

let args = CommandLine.arguments
guard args.count >= 2 else {
    FileHandle.standardError.write(Data("usage: A11ySwiftScan <dir>\n".utf8))
    exit(2)
}

let findings = scanDirectory(root: args[1])

let encoder = JSONEncoder()
encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
let data = try encoder.encode(findings)
print(String(data: data, encoding: .utf8)!)
