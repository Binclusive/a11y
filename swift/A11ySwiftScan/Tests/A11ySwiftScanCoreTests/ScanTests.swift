import XCTest

@testable import A11ySwiftScanCore

/// Exercises the SwiftSyntax ancestor-climb against fixture `.swift` files with
/// known expected findings — the Swift-side equivalent of the JS suite's
/// `test/fixtures/*` + assertions. The two fixtures pin both halves of the
/// precision invariant: a positive case must produce the missing-label findings,
/// and a negative case (every control labeled) must produce NONE (no false
/// positive on a labeled control).
final class ScanTests: XCTestCase {
    /// The `Fixtures/` directory next to this test source. The fixtures are
    /// `exclude`d from compilation (see Package.swift), so we read them off disk
    /// and parse them as text — exactly how the engine sees real `.swift` source.
    private var fixturesDir: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appendingPathComponent("Fixtures")
    }

    private func source(_ fixture: String) throws -> (text: String, path: String) {
        let url = fixturesDir.appendingPathComponent(fixture)
        let text = try String(contentsOf: url, encoding: .utf8)
        return (text, url.path)
    }

    // MARK: - Positive: missing labels must be flagged

    func testMissingLabelFixtureFlagsImageAndControl() throws {
        let (text, path) = try source("MissingLabel.swift")
        let findings = scanSource(text, filePath: path)

        let ruleIds = findings.map(\.ruleId).sorted()
        XCTAssertEqual(
            ruleIds,
            ["swiftui/control-no-name", "swiftui/image-no-label"],
            "the positive fixture must produce exactly one image-no-label and one control-no-name finding; got \(ruleIds)"
        )

        // The bare informative Image is a 1.1.1 violation…
        let imageFinding = try XCTUnwrap(
            findings.first { $0.ruleId == "swiftui/image-no-label" },
            "expected an image-no-label finding for the unlabeled Image"
        )
        XCTAssertEqual(imageFinding.wcag, ["1.1.1"])

        // …and the icon-only Button is a 4.1.2 violation.
        let controlFinding = try XCTUnwrap(
            findings.first { $0.ruleId == "swiftui/control-no-name" },
            "expected a control-no-name finding for the icon-only Button"
        )
        XCTAssertEqual(controlFinding.wcag, ["4.1.2"])
    }

    // MARK: - Negative: labeled controls must NOT be flagged (precision invariant)

    func testLabeledControlFixtureProducesNoFindings() throws {
        let (text, path) = try source("LabeledControl.swift")
        let findings = scanSource(text, filePath: path)

        XCTAssertTrue(
            findings.isEmpty,
            "labeled controls must not be flagged — false positive(s): \(findings.map(\.ruleId))"
        )
    }

    // MARK: - The discovery + scan path over a directory

    func testScanFindingsWalksFixtureDirectory() {
        let findings = scanFindings(in: fixturesDir.path)

        // Only the positive fixture contributes findings; the negative one is clean.
        XCTAssertEqual(
            findings.count, 2,
            "scanning the Fixtures dir should surface exactly the two MissingLabel findings; got \(findings.map(\.ruleId))"
        )
        // Stable order (by file then line) is part of the engine↔TS contract.
        let sorted = zip(findings, findings.dropFirst()).allSatisfy {
            ($0.file, $0.line) <= ($1.file, $1.line)
        }
        XCTAssertTrue(sorted, "findings must be returned in stable (file, line) order")
    }
}
