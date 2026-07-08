package fixtures

import androidx.compose.foundation.Image
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.semantics

// FALSE-NEGATIVE guard for the semantics tightening. The enclosing semantics
// block only MENTIONS the word contentDescription (in a comment) — it never
// assigns one. A raw substring match would wrongly suppress the finding; the
// tightened assignment check must still flag the unlabelled Image.
@Composable
fun MentionsOnly() {
    Modifier.semantics {
        // contentDescription is intentionally left unset here
        Image(painterResource(id = R.drawable.avatar_placeholder))
    }
}
