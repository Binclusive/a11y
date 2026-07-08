package fixtures.hook

import androidx.compose.foundation.Image
import androidx.compose.runtime.Composable
import androidx.compose.ui.res.painterResource

// A contentDescription-less Image — the positive case for compose/image-no-label.
// The engine is mocked in test/hook.test.ts, so this file is a realistic edited
// target, not actually parsed by the suite (JDK-free tier).
@Composable
fun Logo() {
    Image(
        painter = painterResource(id = R.drawable.logo),
    )
}
