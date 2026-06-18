// HARD NEGATIVE (cross-dedup with a floor finding): an UNNAMED Dialog the floor
// already catches (enforce/dialog-no-name → 4.1.2/1.3.1). A grounded recall
// nomination on the SAME line+SC (a 4.1.2 pattern from the dialog slice) dedups
// against the floor finding via `dedupeRecall`'s file:line:sc cross-dedup and
// must surface nothing new. The recall layer exists for what the floor MISSED;
// this 4.1.2 issue is not missed. Exercises the floor-dedup path.

import { Dialog } from "@mui/material";

export const Confirm = ({ open }: { open: boolean }) => (
  <Dialog open={open}>Are you sure?</Dialog>
);
