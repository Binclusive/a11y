// Fixtures for the review_a11y recall gate stack (RFC Phase 1, §1e). Each
// element is a deliberate anchor for one gate test. Lines are looked up by a
// verbatim needle in the test, so the exact text on each JSX line is the contract.

import { Button, IconButton, Tooltip } from "@mui/material";
import { Trash } from "lucide-react";

// A plain anchor with visible text — the static floor does NOT flag it (it has a
// name), so a recall candidate anchored here is NOT deduped away. The SURVIVOR
// anchor for a valid high-confidence common-tier nomination (2.4.4-link-no-name).
export const PlainLink = () => <a href="/home">Home</a>;

// Icon-only IconButton inside a TITLED Tooltip → the floor records a SUPPRESSOR
// (name-injecting-wrapper) on the inner IconButton line. The G3 anchor.
export const TooltipSuppressed = () => (
  <Tooltip title="Delete note">
    <IconButton>
      <Trash />
    </IconButton>
  </Tooltip>
);

// A button whose content is a SPREAD — the floor ABSTAINS (content unknowable)
// on this line for 4.1.2. The G4 anchor.
export const SpreadButton = (props: Record<string, unknown>) => (
  <Button {...props}>
    <Trash />
  </Button>
);
