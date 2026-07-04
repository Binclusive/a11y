// POC fixture: an icon-only button with no accessible name.
//
// The engine's call-site content check (enforce/button-no-name, WCAG 4.1.2)
// fires here: MUI's IconButton is a recognized button whose only child is an
// aria-hidden <svg> — no text, no aria-label — so a screen reader announces
// nothing. This is the "known finding" the container is expected to surface.
//
// NOTE: a bare intrinsic <button> would NOT flag — the engine's static path
// recognizes controls via imported design-system components / resolved hosts,
// not raw lowercase tags (see src/enforce.ts `classify`). Hence the MUI import.
import { IconButton } from "@mui/material";

export function BadButton() {
  return (
    <IconButton onClick={() => console.log("close")}>
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" />
      </svg>
    </IconButton>
  );
}
