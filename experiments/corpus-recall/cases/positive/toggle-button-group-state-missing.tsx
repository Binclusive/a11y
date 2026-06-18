// POSITIVE: a MUI ToggleButton group acting as a single-select control where each
// option is named but NO pressed/selected state is exposed (no `selected`/`value`/
// `aria-pressed`). The options are named, so the floor stays silent; the missing
// selected state is a non-floor SC only the corpus recall layer catches. Pattern:
// 4.1.2-selected-or-current-state-missing (common, eligible to flag).

import { ToggleButton } from "@mui/material";

export const Align = () => (
  <div role="group">
    <ToggleButton value="left">Left</ToggleButton>
    <ToggleButton value="right">Right</ToggleButton>
  </div>
);
