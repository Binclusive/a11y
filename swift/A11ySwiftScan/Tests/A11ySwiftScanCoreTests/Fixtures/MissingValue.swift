import SwiftUI

// POSITIVE fixture — every adjustable control here is missing an
// `.accessibilityValue`, so the engine MUST emit one
// swiftui/control-no-value finding per control (WCAG 4.1.2).
//
// The Slider carries an `.accessibilityLabel` on purpose: a NAME is not a
// VALUE — a label alone must not satisfy the value rule.
struct PlaybackSettings: View {
    @State private var volume = 0.5
    @State private var speed = 1
    @State private var isLooping = false

    var body: some View {
        VStack {
            Slider(value: $volume)
                .accessibilityLabel("Volume")

            Stepper("Playback speed", value: $speed)

            Toggle("Loop", isOn: $isLooping)
        }
    }
}
