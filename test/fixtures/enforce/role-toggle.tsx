// #5 — a Radix Checkbox used nameless with aria-invalid. It traces to host
// `button` but carries role='checkbox', so it is a TOGGLE: enforce must SKIP it
// (toggles are externally labelled — we can't verify their name at the call
// site), the same outcome as a TOGGLE_NAMES match. Reached here via a
// module-keyed RESOLVED host (not the `Checkbox` name), proving the skip is
// role-aware, not name-only. A plain trusted button next to it still flags, so
// the test proves the skip is scoped to the toggle, not a blanket suppression.
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { Button } from "@mui/material";
import { Trash } from "lucide-react";

// role='checkbox' toggle, nameless + aria-invalid → must NOT flag (toggle skip).
export const NamelessRadixCheckbox = () => <CheckboxPrimitive.Root aria-invalid={true} />;

// A genuinely nameless icon-only trusted button alongside → MUST still flag, so
// the role skip is proven NOT to be a blanket "don't flag anything here".
export const NamelessIconButton = () => (
  <Button>
    <Trash />
  </Button>
);
