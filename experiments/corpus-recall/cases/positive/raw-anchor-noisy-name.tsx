// POSITIVE: a design-system Link whose visible text repeats a raw, query-laden
// URL — a polluted accessible name announced verbatim. The Link HAS content, so
// the floor's link-no-name pass is satisfied and stays silent; only the corpus
// recall layer catches the noisy name. Pattern: 2.4.4-noisy-or-wrong-name
// (common, eligible to flag).

import { Link } from "@mui/material";

export const Download = () => (
  <Link href="/files/report.pdf">/files/report.pdf?v=2&token=abc123</Link>
);
