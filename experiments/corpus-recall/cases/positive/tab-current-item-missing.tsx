// POSITIVE: a second design-system Tab control with no current/selected state on
// the active item. Each Tab is named, so the floor stays silent; the missing
// current-item state is a non-floor SC only the corpus recall layer catches.
// Pattern: 4.1.2-selected-or-current-state-missing (common, eligible to flag).

import { Tab } from "@mui/material";

export const Breadcrumb = () => (
  <nav aria-label="Breadcrumb">
    <Tab label="Docs" />
    <Tab label="API" />
  </nav>
);
