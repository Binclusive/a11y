// swift-tools-version:6.1
import PackageDescription

// The static SwiftUI accessibility engine — the 4th collector for the Binclusive
// a11y-checker. Parses `.swift` source with SwiftSyntax and emits a JSON array of
// findings to stdout, one per missing-label / unnamed-control. No Xcode, no
// simulator: this is the precision-floor STATIC layer (mirrors the web tool's
// static jsx-a11y pass). The runtime `performAccessibilityAudit()` half is out of
// scope here — it attaches on a Mac with Xcode later.
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
        // The rule engine — file discovery, the visitor, and the ancestor-climb
        // heuristic. A library so the test target can `@testable import` it and
        // drive `scanSource` on inline fixtures (an executable can't be imported).
        .target(
            name: "A11ySwiftScanCore",
            dependencies: [
                .product(name: "SwiftSyntax", package: "swift-syntax"),
                .product(name: "SwiftParser", package: "swift-syntax"),
            ]
        ),
        // The thin CLI shell over `scanDirectory` — prints the findings JSON.
        .executableTarget(
            name: "A11ySwiftScan",
            dependencies: ["A11ySwiftScanCore"]
        ),
        // Rule-level coverage: fixtures → expected findings, run with `swift test`.
        .testTarget(
            name: "A11ySwiftScanCoreTests",
            dependencies: ["A11ySwiftScanCore"]
        ),
    ]
)
