// HARD NEGATIVE (the precision spine): the SAME icon-only IconButton as the
// positive, but wrapped in a TITLED <Tooltip>. MUI clones the child and injects
// the title as its aria-label, so the control IS named — a recall nomination of
// 4.1.2-button-no-name here is a false positive the floor's name-injecting-
// wrapper suppressor (G3) must veto. Exercises G3.

import { IconButton, Tooltip } from "@mui/material";
import { Trash } from "lucide-react";

export const DeleteButton = () => (
  <Tooltip title="Delete note">
    <IconButton>
      <Trash />
    </IconButton>
  </Tooltip>
);
