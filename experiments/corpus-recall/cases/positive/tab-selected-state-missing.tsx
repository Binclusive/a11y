// POSITIVE: a custom tab control with no selected/current state exposed. The
// floor has no rule for missing selected-state on a trusted Tab component, so
// only the corpus recall layer can flag it. Pattern:
// 4.1.2-selected-or-current-state-missing (common, eligible to flag).

import { Tab } from "@mui/material";

export const Nav = () => (
  <nav>
    <Tab label="Home" />
    <Tab label="Profile" />
  </nav>
);
