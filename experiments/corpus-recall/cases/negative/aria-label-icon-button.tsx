// HARD NEGATIVE: the SAME icon-only IconButton, but with an explicit aria-label
// on the call site — it IS named. The floor's enforce pass returns `clean` (a
// genuinely named control: no finding, and NO G4 abstention marker — only
// unknowable content, spread props or dynamic children, records that). A
// 4.1.2-button-no-name nomination here would be a false positive on
// correctly-named code; the recall layer must surface ZERO findings. This is the
// named-control precision spine, not a G4 exercise.

import { IconButton } from "@mui/material";
import { Trash } from "lucide-react";

export const DeleteButton = () => (
  <IconButton aria-label="Delete note">
    <Trash />
  </IconButton>
);
