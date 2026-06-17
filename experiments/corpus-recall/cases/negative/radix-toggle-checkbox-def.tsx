// The DEFINITION half of the Radix-style toggle decoy (S1, finding #2). A
// homegrown `Checkbox.Root`-shaped wrapper that resolves to host `button` but
// carries a static `role="checkbox"` — a TOGGLE. The trace captures the role, so
// the resolved-host map marks the call site `toggle-role`. This file MUST be in
// the scan set for the resolution to happen — which is exactly the cross-file
// fact the eval was blind to before #6 (one-file-per-candidate hid it).
import type * as React from "react";

export const CheckboxRoot = (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
  <button role="checkbox" {...props} />
);
