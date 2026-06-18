// POSITIVE: MUI MenuItem rows used as a navigation list — each item is named but
// NO current state is exposed (no `selected`/`aria-current`). The items are named,
// so the floor stays silent; the missing current-item state is a non-floor SC
// only the corpus recall layer catches. Pattern:
// 4.1.2-selected-or-current-state-missing (common, eligible to flag).

import { MenuItem } from "@mui/material";

export const SideNav = () => (
  <nav>
    <MenuItem>Dashboard</MenuItem>
    <MenuItem>Reports</MenuItem>
  </nav>
);
