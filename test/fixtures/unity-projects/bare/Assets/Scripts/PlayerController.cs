using UnityEngine;
using UnityEngine.InputSystem;

// Reads the new Input System but never offers a rebinding path, and the project
// ships no `.inputactions` asset (a fixed, non-remappable control scheme — the
// motor-accessibility gap).
public class PlayerController : MonoBehaviour
{
    private Vector2 moveInput;

    public void OnMove(InputAction.CallbackContext context)
    {
        moveInput = context.ReadValue<Vector2>();
    }

    void Update()
    {
        transform.Translate(moveInput * Time.deltaTime);
    }
}
