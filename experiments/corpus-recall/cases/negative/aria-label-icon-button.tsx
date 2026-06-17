// HARD NEGATIVE: the SAME icon-only IconButton, but with an explicit aria-label
// on the call site — it IS named. A 4.1.2-button-no-name nomination here is a
// misclassification of correctly-named code. The floor's enforce pass considers
// this control type at this line and abstains/clears it; exercises G4 (the
// abstention veto) — the floor deliberately stays silent on a named control.

import { IconButton } from "@mui/material";
import { Trash } from "lucide-react";

export const DeleteButton = () => (
  <IconButton aria-label="Delete note">
    <Trash />
  </IconButton>
);
