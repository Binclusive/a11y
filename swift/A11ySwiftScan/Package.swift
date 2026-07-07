// swift-tools-version:6.1
import PackageDescription

// The static SwiftUI accessibility engine — the 4th collector for the Binclusive
// a11y-checker. Parses `.swift` source with SwiftSyntax and emits a JSON array of
// findings to stdout, one per missing-label / unnamed-control. No Xcode, no
// simulator: this is the precision-floor STATIC layer (mirrors the web tool's
// static jsx-a11y pass). The runtime `performAccessibilityAudit()` half is out of
// scope here — it attaches on a Mac with Xcode later.
//
// Three targets, split so the engine is testable:
//   - A11ySwiftScanCore  (library)    — the whole engine: file discovery, the
//        SwiftSyntax climb (SyntaxClimb / A11yVisitor), the Finding contract, and
//        the JSON CLI driver. This is what tests `@testable import`.
//   - A11ySwiftScan      (executable) — a thin shell that forwards argv to the
//        library's `runA11ySwiftScan(arguments:)`.
//   - A11ySwiftScanCoreTests (tests)  — drives the climb against fixture `.swift`
//        files with known expected findings, guarding the precision invariant.
let package = Package(
    name: "A11ySwiftScan",
    platforms: [.macOS(.v13)],
    dependencies: [
        .package(
            url: "https://github.com/swiftlang/swift-syntax.git",
            from: "601.0.1"
        )
    ],
    targets: [
        .target(
            name: "A11ySwiftScanCore",
            dependencies: [
                .product(name: "SwiftSyntax", package: "swift-syntax"),
                .product(name: "SwiftParser", package: "swift-syntax"),
            ]
        ),
        .executableTarget(
            name: "A11ySwiftScan",
            dependencies: ["A11ySwiftScanCore"]
        ),
        .testTarget(
            name: "A11ySwiftScanCoreTests",
            dependencies: ["A11ySwiftScanCore"],
            // The fixtures are PARSED as source text by the engine, never
            // compiled into the test module — excluding them keeps CI from
            // needing SwiftUI to typecheck them and keeps the test a pure
            // parse-the-text-and-assert exercise.
            exclude: ["Fixtures"]
        ),
    ]
)
