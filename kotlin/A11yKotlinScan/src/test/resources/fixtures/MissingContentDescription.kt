package fixtures

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Column
import androidx.compose.runtime.Composable
import androidx.compose.ui.res.painterResource

// POSITIVE fixture — the Image here is missing a contentDescription, so the
// engine MUST emit exactly one compose/image-no-label finding. Mirrors the Swift
// engine's MissingLabel.swift: a small, hand-written composable with a KNOWN
// expected finding.
@Composable
fun ProfileCard() {
    Column {
        // Informative image with no contentDescription and no naming ancestor —
        // WCAG 1.1.1. Expected finding: compose/image-no-label on this line.
        Image(painterResource(id = R.drawable.avatar_placeholder))
    }
}
