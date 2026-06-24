using System.Collections;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.UI;

// In the shape of UnityTechnologies/open-project-1 @ 608eac9: ordinary gameplay
// MonoBehaviour with NO reference to UnityEngine.Accessibility — the canonical
// "the game is unusable with a screen reader" ground truth.
public class ShowTime : MonoBehaviour
{
    public float currentTime = 0;

    void Start()
    {
    }

    void Update()
    {
        currentTime = Time.timeSinceLevelLoad;
        Text text = gameObject.GetComponent<Text>();
        text.text = "Time:" + currentTime;
    }
}
