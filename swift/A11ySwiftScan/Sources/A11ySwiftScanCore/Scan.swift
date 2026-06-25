import Foundation
import SwiftParser
import SwiftSyntax

// The library entry points for the static SwiftUI accessibility engine. The
// `A11ySwiftScan` executable is a thin `main.swift` over `scanDirectory`; the
// test target imports this module and drives `scanSource` on inline fixtures so
// the climb heuristics are covered without compiling Swift on disk.

// MARK: - File discovery

/// Directory names that hold tests / build artifacts / dependencies — their
/// `.swift` files are not shipped UI, so a finding in one is noise. Mirrors the
/// TS `collectTsx` skip set.
public let skipDirs: Set<String> = [
    ".build", ".git", "Pods", "Carthage", "DerivedData",
    "Tests", "__tests__", "__mocks__", "fastlane", "vendor",
    "checkouts",
]

/// Is this a test/spec file by name? `FooTests.swift`, `FooSpec.swift`.
public func isTestFile(_ name: String) -> Bool {
    name.hasSuffix("Tests.swift") || name.hasSuffix("Spec.swift")
        || name.hasSuffix("Test.swift")
}

public func collectSwiftFiles(under root: String) -> [String] {
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

// MARK: - Scanning

/// Parse one `.swift` source string and return its findings. This is the unit the
/// test target drives directly (no filesystem), and the per-file core that
/// `scanDirectory` calls. `filePath` is recorded on each finding and used for the
/// source-location converter, so tests can pass any label (e.g. `"Test.swift"`).
public func scanSource(_ source: String, filePath: String) -> [Finding] {
    let tree = Parser.parse(source: source)
    let converter = SourceLocationConverter(fileName: filePath, tree: tree)
    let visitor = A11yVisitor(filePath: filePath, converter: converter)
    visitor.walk(tree)
    return visitor.findings
}

/// Recursively scan every shipped `.swift` file under `root`, returning all
/// findings in a stable (file, line) order so the JSON the executable prints is
/// deterministic across runs.
public func scanDirectory(root: String) -> [Finding] {
    var all: [Finding] = []
    for path in collectSwiftFiles(under: root) {
        guard let source = try? String(contentsOfFile: path, encoding: .utf8) else { continue }
        all.append(contentsOf: scanSource(source, filePath: path))
    }
    all.sort { ($0.file, $0.line) < ($1.file, $1.line) }
    return all
}
