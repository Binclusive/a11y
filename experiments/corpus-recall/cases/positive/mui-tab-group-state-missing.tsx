// POSITIVE: a MUI Tab group where each tab is named but NO selected/current state
// is exposed (no `value`/`selected`/`aria-selected`/`aria-current`). The items
// are named, so the floor stays silent; the missing selected state is a non-floor
// SC only the corpus recall layer catches. Pattern:
// 4.1.2-selected-or-current-state-missing (common, eligible to flag).

import { Tab } from "@mui/material";

export const Nav = () => (
  <nav>
    <Tab label="Overview" />
    <Tab label="Billing" />
  </nav>
);
