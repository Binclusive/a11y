// HARD NEGATIVE (G3 label-ancestor): a custom Slider wrapped in a native
// <label>. The enclosing label names the control, so the floor's label-ancestor
// suppressor marks the Slider's line. A recall nomination on the inner Slider
// (e.g. 2.1.1-custom-widget-no-keyboard) is then a false positive G3 must veto.
// Exercises G3 on the label path.

import { Slider } from "@mui/material";

export const Brightness = () => (
  <label>
    Brightness
    <Slider value={30} />
  </label>
);
