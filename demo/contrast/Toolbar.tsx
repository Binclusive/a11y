import { IconButton, TextField, Button } from "@mui/material";

// A realistic toolbar built from a popular design system (MUI).
export function Toolbar() {
  return (
    <div>
      {/* icon-only button, no accessible name — screen readers announce "button" */}
      <IconButton>
        <svg width="16" height="16" />
      </IconButton>

      {/* a placeholder is NOT a label */}
      <TextField placeholder="Search invoices" />

      {/* correct usage — must NOT be flagged (zero false positives) */}
      <Button>Save</Button>

      {/* the one a normal linter DOES catch */}
      <img src="/logo.png" />
    </div>
  );
}
