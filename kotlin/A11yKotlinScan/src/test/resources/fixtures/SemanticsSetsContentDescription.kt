package fixtures

import androidx.compose.foundation.Image
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics

// NEGATIVE: the enclosing semantics block genuinely SETS contentDescription, so
// the Image inherits an accessible name — MUST NOT be flagged. Guards that the
// tightening did not over-correct into a false positive.
@Composable
fun SemanticsLabeled() {
    Modifier.semantics {
        contentDescription = "User avatar"
        Image(painterResource(id = R.drawable.avatar_placeholder))
    }
}
