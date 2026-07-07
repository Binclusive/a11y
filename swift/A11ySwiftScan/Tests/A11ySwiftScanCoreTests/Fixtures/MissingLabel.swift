import SwiftUI

// POSITIVE fixture — every control here is missing an accessible name, so the
// engine MUST emit a finding for each. Mirrors the `test/fixtures/*` shape used
// by the JS suite: a small, hand-written component with KNOWN expected findings.
//
// Expected findings (asserted in ScanTests):
//   - swiftui/image-no-label  on the bare `Image("avatar-placeholder")`
//        (informative image, no label, no naming ancestor — WCAG 1.1.1)
//   - swiftui/control-no-name on the icon-only `Button`
//        (VoiceOver announces nothing — WCAG 4.1.2)
struct ProfileCard: View {
    var body: some View {
        HStack {
            // Informative image with no `.accessibilityLabel` and no naming
            // ancestor (HStack is not an accessibility-element container).
            Image("avatar-placeholder")

            // Icon-only button: the symbol carries no action name, and there is
            // no `.accessibilityLabel` on the Button.
            Button(action: share) {
                Image(systemName: "square.and.arrow.up")
            }
        }
    }

    func share() {}
}
