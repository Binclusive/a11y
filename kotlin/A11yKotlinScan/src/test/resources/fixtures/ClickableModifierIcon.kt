package fixtures

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Row
import androidx.compose.material3.Icon
import androidx.compose.material.icons.Icons
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier

// SEVERITY-TIER fixture: an unlabelled Icon inside a container whose `modifier =`
// carries a `Modifier.clickable { }` chain. The clickable modifier is a SIBLING
// of the Icon (in Row's modifier argument), not an ancestor call, so the tier
// must be resolved by inspecting the container's modifier — the missing name on
// an interactive element is `critical`, not `serious`.
@Composable
fun ClickableRow(onClick: () -> Unit) {
    Row(modifier = Modifier.clickable { onClick() }) {
        Icon(Icons.Default.Add)
    }
}
