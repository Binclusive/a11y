import SwiftUI

// NEGATIVE fixture — every control here HAS an accessible name, so the engine
// MUST emit ZERO findings. This guards the precision invariant: the climb must
// stay opaque / find the name rather than misfire a false positive on a labeled
// control (the failure mode that gets an a11y tool uninstalled).
//
// Each control names itself a different valid way, exercising distinct seams of
// the SyntaxClimb name predicate:
//   - `.accessibilityLabel` directly on an Image's modifier chain
//   - `.accessibilityLabel` on a Button's modifier chain
//   - a leading string-literal title on a `Button("…")`
struct AccessibleCard: View {
    var body: some View {
        HStack {
            Image("avatar-placeholder")
                .accessibilityLabel("User avatar")

            Button(action: share) {
                Image(systemName: "square.and.arrow.up")
            }
            .accessibilityLabel("Share profile")

            Button("Follow") {
                follow()
            }
        }
    }

    func share() {}
    func follow() {}
}
