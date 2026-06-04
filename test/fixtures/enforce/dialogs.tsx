// Dialog-control fixtures — the fuzziest control, so the rule is the most
// conservative. A dialog is recognized only by a `*Dialog`/`*Modal` name; it is
// flagged ONLY when we can SEE a static body that carries no title subcomponent
// and no name attribute. Self-closing / opaque dialogs are left alone (they
// render their own title internally).
//
// Imported from @mantine/core — a GUARANTEED design system, so the name
// heuristic legitimately fires (the gate requires a known library). An opaque
// `Dialog` from an UNRECOGNIZED module is no longer recognized by name (that was
// the over-broad behavior the hardening-3 #1 gate removed).

import { Dialog, DialogTitle } from "@mantine/core";

// Self-closing opaque dialog → NO flag (renders its own title internally).
export const SelfClosingDialog = () => <Dialog open onOpenChange={() => {}} />;

// Visible body, a DialogTitle subcomponent → named → NO flag.
export const TitledDialog = () => (
  <Dialog open>
    <DialogTitle>Confirm</DialogTitle>
    <p>Are you sure?</p>
  </Dialog>
);

// Visible static body, NO title subcomponent, NO name attr → FLAGS 4.1.2/1.3.1.
export const NamelessDialog = () => (
  <Dialog open>
    <div>
      <p>Body with no heading.</p>
    </div>
  </Dialog>
);

// aria-label present → named → NO flag.
export const LabelledDialog = () => (
  <Dialog open aria-label="Settings">
    <div>
      <p>Body.</p>
    </div>
  </Dialog>
);
