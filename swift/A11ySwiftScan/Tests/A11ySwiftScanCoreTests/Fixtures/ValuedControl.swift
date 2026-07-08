import SwiftUI

// NEGATIVE fixture — every adjustable control here describes its current value
// (or is deliberately out of the accessibility tree), so the engine MUST emit
// ZERO findings. This guards the precision invariant: flag the shape or stay
// opaque, never mis-flag a correctly-authored control.
//
// Each control is covered a different valid way, exercising distinct seams of
// the value predicate:
//   - `.accessibilityValue` directly on the Slider's modifier chain
//   - `.accessibilityValue` after an intervening modifier on the Stepper's chain
//   - `.accessibilityValue` with a computed argument on the Toggle
//   - `.accessibilityHidden(true)` — intentionally removed from the tree
//   - `.accessibilityRepresentation` — a custom representation replaces the
//     element wholesale (its inner control carries its own value)
struct AccessiblePlaybackSettings: View {
    @State private var volume = 0.5
    @State private var speed = 1
    @State private var isLooping = false

    var body: some View {
        VStack {
            Slider(value: $volume)
                .accessibilityLabel("Volume")
                .accessibilityValue("\(Int(volume * 100)) percent")

            Stepper("Playback speed", value: $speed)
                .padding()
                .accessibilityValue("\(speed)x")

            Toggle("Loop", isOn: $isLooping)
                .accessibilityValue(isLooping ? "On" : "Off")

            Slider(value: $volume)
                .accessibilityHidden(true)

            Stepper("Zoom", value: $speed)
                .accessibilityRepresentation {
                    Slider(value: $volume)
                        .accessibilityValue("\(Int(volume * 100)) percent")
                }
        }
    }
}
