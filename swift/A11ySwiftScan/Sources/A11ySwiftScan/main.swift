import Foundation
import SwiftParser
import SwiftSyntax

// A11ySwiftScan <dir>
//
// Recursively parses every `.swift` file under <dir> (skipping test/build dirs),
// applies the two STATIC SwiftUI accessibility rules with the ancestor-climb
// heuristic, and prints a JSON array of findings to stdout. This is the engine
// the TS `scanSwift` collector (src/collect-swift.ts) shells to, mirroring how
// `scanUrl` shells to the external DOM engine.

// MARK: - File discovery

/// Directory names that hold tests / build artifacts / dependencies — their
/// `.swift` files are not shipped UI, so a finding in one is noise. Mirrors the
/// TS `collectTsx` skip set.
let skipDirs: Set<String> = [
    ".build", ".git", "Pods", "Carthage", "DerivedData",
    "Tests", "__tests__", "__mocks__", "fastlane", "vendor",
    "checkouts",
]

/// Is this a test/spec file by name? `FooTests.swift`, `FooSpec.swift`.
func isTestFile(_ name: String) -> Bool {
    name.hasSuffix("Tests.swift") || name.hasSuffix("Spec.swift")
        || name.hasSuffix("Test.swift")
}

func collectSwiftFiles(under root: String) -> [String] {
    let fm = FileManager.default
    var out: [String] = []
    guard let en = fm.enumerator(
        at: URL(fileURLWithPath: root),
        includingPropertiesForKeys: [.isDirectoryKey],
        options: [.skipsHiddenFiles]
    ) else { return out }

    for case let url as URL in en {
        let name = url.lastPathComponent
        var isDir: ObjCBool = false
        fm.fileExists(atPath: url.path, isDirectory: &isDir)
        if isDir.boolValue {
            if skipDirs.contains(name) {
                en.skipDescendants()
            }
            continue
        }
        guard name.hasSuffix(".swift"), !isTestFile(name) else { continue }
        out.append(url.path)
    }
    return out.sorted()
}

// MARK: - Driver

let args = CommandLine.arguments
guard args.count >= 2 else {
    FileHandle.standardError.write(Data("usage: A11ySwiftScan <dir>\n".utf8))
    exit(2)
}
let root = args[1]

var allFindings: [Finding] = []
for path in collectSwiftFiles(under: root) {
    guard let source = try? String(contentsOfFile: path, encoding: .utf8) else { continue }
    let tree = Parser.parse(source: source)
    let converter = SourceLocationConverter(fileName: path, tree: tree)
    let visitor = A11yVisitor(filePath: path, converter: converter)
    visitor.walk(tree)
    allFindings.append(contentsOf: visitor.findings)
}

// Stable order: by file then line, so the JSON is deterministic across runs.
allFindings.sort { ($0.file, $0.line) < ($1.file, $1.line) }

let encoder = JSONEncoder()
encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
let data = try encoder.encode(allFindings)
print(String(data: data, encoding: .utf8)!)
