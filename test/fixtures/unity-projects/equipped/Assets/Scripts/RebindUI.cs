using UnityEngine;
using UnityEngine.InputSystem;

// Offers an interactive control-rebinding path via PerformInteractiveRebinding —
// the presence of this call (and/or the .inputactions asset below) is what makes
// no-input-rebinding SILENT.
public class RebindUI : MonoBehaviour
{
    public InputActionReference action;

    public void StartRebind()
    {
        action.action.PerformInteractiveRebinding()
            .OnComplete(op => op.Dispose())
            .Start();
    }
}
