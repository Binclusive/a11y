// SettingsForm — the RECALL WIN. These controls come from @acme/ui, a design
// system that is declared in package.json but NOT installed on disk, so the
// COLD scan can't see inside them: they land in `declare` (opaque) and the
// missing-deps note fires.
//
// AFTER you declare the 3 primitives in binclusive.json
// (Button->button, IconButton->button, TextField->input), the call-site
// content check (enforce) inspects what the app PASSES to these wrappers and
// catches the two hidden bugs below — findings the cold scan never reported.
import { Button, IconButton, TextField } from "@acme/ui";
import { TrashIcon } from "lucide-react";

export function SettingsForm() {
  return (
    <form>
      <h1>Account settings</h1>

      {/* BUG (hidden until declared): placeholder is NOT a label — 1.3.1 / 4.1.2.
          Surfaces only after TextField is declared as an input host. */}
      <TextField placeholder="Email" />

      {/* CORRECT: a properly labelled field — zero false positive expected */}
      <TextField label="Full name" />

      {/* BUG (hidden until declared): icon-only IconButton, no aria-label — 4.1.2.
          Surfaces only after IconButton is declared as a button host. */}
      <IconButton>
        <TrashIcon />
      </IconButton>

      {/* CORRECT: a labelled button — zero false positive expected */}
      <Button>Save changes</Button>
    </form>
  );
}
