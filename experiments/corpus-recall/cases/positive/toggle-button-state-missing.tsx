// POSITIVE: a design-system ToggleButton with no pressed/selected state exposed.
// The floor has no rule for missing toggle state on a trusted ToggleButton, so
// only the corpus recall layer can flag it. Pattern:
// 4.1.2-selected-or-current-state-missing (common, eligible to flag).

import { ToggleButton } from "@mui/material";

export const Bold = () => <ToggleButton value="bold">B</ToggleButton>;
