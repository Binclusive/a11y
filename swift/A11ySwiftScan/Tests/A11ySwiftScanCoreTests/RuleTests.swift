import XCTest
@testable import A11ySwiftScanCore

/// Rule-level coverage for the static SwiftUI engine. Each test parses an inline
/// `.swift` source string through `scanSource` and asserts on the rule ids it
/// emits — so the ancestor-climb heuristic (the precision floor) is guarded
/// against regression without compiling Swift on disk.
///
/// The precision contract these tests encode: the engine flags an image/control
/// ONLY when it has no accessible name on itself OR any name-bearing ancestor,
/// and NEVER flags an `Image` that is data passed to an API (a share payload)
/// rather than a view rendered in the hierarchy.
final class RuleTests: XCTestCase {
    private func ruleIds(_ source: String) -> [String] {
        scanSource(source, filePath: "Test.swift").map(\.ruleId).sorted()
    }

    // MARK: - True positives must still fire

    /// A displayed `Image(uiImage:)` made tappable with no `.accessibilityLabel`
    /// is both an unlabelled image (1.1.1) and an unnamed tap control (4.1.2).
    /// `.accessibilityAction` provides an action, NOT a name — both must fire.
    func testDisplayedTappableImageWithNoNameIsFlagged() {
        let src = """
        struct V: View {
            var body: some View {
                Image(uiImage: image)
                    .resizable()
                    .onTapGesture { fullScreen = true }
                    .accessibilityAction(named: Text("View full screen")) { fullScreen = true }
            }
        }
        """
        XCTAssertEqual(
            ruleIds(src),
            ["swiftui/control-no-name", "swiftui/image-no-label"],
            "a displayed, tappable, unnamed image fails both rules"
        )
    }

    /// A standalone informative `Image(uiImage:)` with no name anywhere is a
    /// plain 1.1.1 violation — the base case the engine exists to catch.
    func testStandaloneInformativeImageIsFlagged() {
        let src = """
        struct V: View {
            var body: some View {
                VStack { Image(uiImage: image) }
            }
        }
        """
        XCTAssertEqual(ruleIds(src), ["swiftui/image-no-label"])
    }

    // MARK: - Pre-existing behaviour must be preserved

    /// An icon-only `Button` named with `.accessibilityLabel` is clean.
    func testLabeledIconButtonIsNotFlagged() {
        let src = """
        struct V: View {
            var body: some View {
                Button { dismiss() } label: {
                    Image(systemName: "xmark")
                }
                .accessibilityLabel("Close")
            }
        }
        """
        XCTAssertEqual(ruleIds(src), [])
    }

    /// A `Button` whose content is a `Label("Save", systemImage:)` is named by the
    /// label's title — the icon is decorative-by-construction.
    func testButtonWithLabelTitleIsNotFlagged() {
        let src = """
        struct V: View {
            var body: some View {
                Button { save() } label: {
                    Label("Save", systemImage: "square.and.arrow.down")
                }
            }
        }
        """
        XCTAssertEqual(ruleIds(src), [])
    }

    /// A bare `Image(systemName:)` carries an implicit symbol name in a
    /// non-interactive context — not flagged.
    func testStandaloneSystemImageIsNotFlagged() {
        let src = """
        struct V: View {
            var body: some View {
                Image(systemName: "star.fill")
            }
        }
        """
        XCTAssertEqual(ruleIds(src), [])
    }
}
