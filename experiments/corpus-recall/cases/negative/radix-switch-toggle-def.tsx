// The DEFINITION half of the Radix-style switch decoy. A homegrown switch
// wrapper that resolves to host `button` but carries a static `role="switch"` —
// a TOGGLE. The trace captures the role, so the resolved-host map marks the call
// site `toggle-role`. This file MUST be in the scan set for the resolution to
// happen (the cross-file fact the eval reads off disk via the import).
import type * as React from "react";

export const SwitchRoot = (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
  <button role="switch" {...props} />
);
