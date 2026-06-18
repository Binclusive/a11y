// POSITIVE: a link whose visible text is a raw filename ("q3-report-final-v2-
// FINAL.pdf") — a polluted accessible name a screen reader announces verbatim.
// The link HAS content, so the floor's link-no-name pass is satisfied; only the
// corpus recall layer catches the noisy name. Pattern: 2.4.4-noisy-or-wrong-name
// (common, eligible to flag).

import { Link } from "@mui/material";

export const FileLink = () => (
  <Link href="/files/q3.pdf">q3-report-final-v2-FINAL.pdf</Link>
);
