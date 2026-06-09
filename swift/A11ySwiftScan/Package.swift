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
        .executableTarget(
            name: "A11ySwiftScan",
            dependencies: [
                .product(name: "SwiftSyntax", package: "swift-syntax"),
                .product(name: "SwiftParser", package: "swift-syntax"),
            ]
        )
    ]
)
