// POSITIVE: a Mantine-style Tab with no selected/current state exposed on the
// active item. Each Tab is named, so the floor stays silent; the missing
// selected state is a non-floor SC only the corpus recall layer catches.
// Pattern: 4.1.2-selected-or-current-state-missing (common, eligible to flag).

import { Tab } from "@mui/material";

export const Settings = () => (
  <nav>
    <Tab label="Account" />
    <Tab label="Security" />
  </nav>
);
