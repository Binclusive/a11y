// HARD NEGATIVE (G3 name-injecting-wrapper): a generic-text Link ("read more")
// wrapped in a TITLED <Tooltip>. The tooltip title injects a descriptive
// accessible name, so the link is named despite the generic visible text. A
// 2.4.4-generic-link-text nomination on the inner Link sits on a line the floor's
// name-injecting-wrapper suppressor (G3) marks, so it must be vetoed. Exercises
// G3 on the link path.

import { Link, Tooltip } from "@mui/material";

export const More = () => (
  <Tooltip title="Read the full admissions guide">
    <Link href="/admissions">read more</Link>
  </Tooltip>
);
