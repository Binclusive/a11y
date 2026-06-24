using UnityEngine;
using UnityEngine.Accessibility;

// Hand-authored screen-reader support: builds an AccessibilityHierarchy of
// AccessibilityNodes and registers it with AssistiveSupport. Presence of these
// UnityEngine.Accessibility references is what makes no-screen-reader-support SILENT.
public class A11yBridge : MonoBehaviour
{
    void OnEnable()
    {
        var hierarchy = new AccessibilityHierarchy();
        var node = new AccessibilityNode { label = "Start Game" };
        hierarchy.AddNode(node);
        AssistiveSupport.activeHierarchy = hierarchy;
    }
}
