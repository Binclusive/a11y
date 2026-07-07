import Foundation
import SwiftParser
import SwiftSyntax

// MARK: - The engine entry points (the testability seam)
//
// This file is what makes the SwiftSyntax climb reachable from a test target.
// The `A11ySwiftScanCore` library owns ALL the behavior — file discovery, the
// per-source parse+walk, and the JSON-emitting CLI driver — and the
// `A11ySwiftScan` executable is a thin shell that just forwards its arguments to
// `runA11ySwiftScan(arguments:)`. Tests `@testable import A11ySwiftScanCore` and
// drive `scanSource(_:filePath:)` / `scanFindings(in:)` directly against fixture
// `.swift` files, so a regression in `SyntaxClimb`/`A11yVisitor` (a missing-label
// misfire, a false positive on a labeled control) fails `swift test` instead of
// shipping silently.

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

// MARK: - The scan

/// Parse ONE Swift source string and return its findings. This is the unit the
/// test target drives against fixture `.swift` files — it is the whole engine for
/// a single file (parse → walk → climb → emit), with no filesystem or stdout in
/// the way. `filePath` is the label stamped onto each finding's `file` field.
func scanSource(_ source: String, filePath: String) -> [Finding] {
    let tree = Parser.parse(source: source)
    let converter = SourceLocationConverter(fileName: filePath, tree: tree)
    let visitor = A11yVisitor(filePath: filePath, converter: converter)
    visitor.walk(tree)
    return visitor.findings
}

/// Discover every shippable `.swift` file under `root` and scan each, returning a
/// stably-ordered (by file then line) array of findings.
func scanFindings(in root: String) -> [Finding] {
    var allFindings: [Finding] = []
    for path in collectSwiftFiles(under: root) {
        guard let source = try? String(contentsOfFile: path, encoding: .utf8) else { continue }
        allFindings.append(contentsOf: scanSource(source, filePath: path))
    }
    allFindings.sort { ($0.file, $0.line) < ($1.file, $1.line) }
    return allFindings
}

// MARK: - The CLI driver

/// The whole `A11ySwiftScan <dir>` CLI, lifted out of `main.swift` so the
/// executable is a thin shell over this library. Scans `<dir>`, prints a JSON
/// array of findings to stdout, and returns the process exit code (`2` on a
/// usage error). `public` so the `import A11ySwiftScanCore` executable can call it
/// (everything else stays `internal`, reachable only via `@testable`).
public func runA11ySwiftScan(arguments: [String]) -> Int32 {
    guard arguments.count >= 2 else {
        FileHandle.standardError.write(Data("usage: A11ySwiftScan <dir>\n".utf8))
        return 2
    }
    let root = arguments[1]
    let allFindings = scanFindings(in: root)

    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    guard let data = try? encoder.encode(allFindings),
          let json = String(data: data, encoding: .utf8) else {
        FileHandle.standardError.write(Data("error: failed to encode findings\n".utf8))
        return 1
    }
    print(json)
    return 0
}
