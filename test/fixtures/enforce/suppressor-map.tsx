// Fixtures for buildSuppressorMap (RFC Phase 1, §1b / G3). Each export isolates
// one suppressor shape so a test can assert exactly which suppressor names land
// on which line. The line of the CONTROL (the inner element) is what the map
// keys on — the same line a finding/abstention anchors to.

import { IconButton, Tooltip } from "@mui/material";
import { FormLabel } from "@mui/material";
import { Trash } from "lucide-react";

// A titled MUI Tooltip injects its child's name → the inner IconButton line
// carries `name-injecting-wrapper` (an ANCESTOR suppressor).
export const TooltipTitledIconButton = () => (
  <Tooltip title="Delete note">
    <IconButton>
      <Trash />
    </IconButton>
  </Tooltip>
);

// A FormLabel-wrapped input → the inner <input> line carries `label-ancestor`.
export const FormLabelInput = () => (
  <FormLabel>
    Email
    <input type="text" />
  </FormLabel>
);

// A hidden input → `hidden-untabbable` on its own line.
export const HiddenInput = () => <input className="sr-only hidden" />;

// A name-exempt input type → `name-exempt-input-type` on its own line.
export const SubmitInput = () => <input type="submit" value="Send" />;

// A toggle-role control → `toggle-role` on its own line.
export const ToggleRoleControl = () => <div role="switch" />;

// A clean control under nothing → NO suppressor on its line.
export const CleanButton = () => (
  <IconButton aria-label="Save">
    <Trash />
  </IconButton>
);
