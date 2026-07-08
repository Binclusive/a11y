package fixtures.aggregate

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Column
import androidx.compose.runtime.Composable
import androidx.compose.ui.res.painterResource

// DEDICATED aggregate subtree — owned solely by `directoryScanSurfacesOnly...`.
// The dir-scan test asserts a GLOBAL count over the directory it scans, so it
// must own a subtree no sibling PR mutates (CLAUDE.md "Dir-level scan tests own a
// dedicated fixture subtree"; the #84/#77 cross-PR collision class). This file is
// the only member: exactly one unlabeled Image → exactly one finding.
@Composable
fun AggregateProbe() {
    Column {
        Image(painterResource(id = R.drawable.avatar_placeholder))
    }
}
