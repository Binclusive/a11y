// HARD NEGATIVE (G3 name-injecting-wrapper): a custom Slider wrapped in a TITLED
// <Tooltip>. MUI clones the child and injects the title as its accessible name,
// so the control IS named. A recall nomination on the inner Slider (e.g.
// 2.1.1-custom-widget-no-keyboard) sits on a line the floor's name-injecting-
// wrapper suppressor (G3) marks, so it must be vetoed. Exercises G3.

import { Slider, Tooltip } from "@mui/material";

export const Volume = () => (
  <Tooltip title="Volume">
    <Slider value={50} />
  </Tooltip>
);
