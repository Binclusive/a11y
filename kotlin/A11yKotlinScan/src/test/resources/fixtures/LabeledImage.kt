package fixtures

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.ui.res.painterResource

// NEGATIVE fixture — every Image/Icon here HAS an accessible name (or is
// explicitly decorative), so the engine MUST emit ZERO findings. This guards the
// precision invariant: the engine must find the name / stay opaque rather than
// misfire a false positive (the failure mode that gets an a11y tool uninstalled).
//
// Each control supplies its name a different valid way, exercising distinct seams:
//   - a named `contentDescription =` argument
//   - a POSITIONAL contentDescription (the 2nd positional argument)
//   - `contentDescription = null` (the documented Compose decorative marker)
@Composable
fun AccessibleCard() {
    Column {
        Image(
            painter = painterResource(id = R.drawable.avatar_placeholder),
            contentDescription = "User avatar",
        )

        Icon(Icons.Default.Share, "Share profile")

        Image(
            painter = painterResource(id = R.drawable.divider),
            contentDescription = null,
        )
    }
}
