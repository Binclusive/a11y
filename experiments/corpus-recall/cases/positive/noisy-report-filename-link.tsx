// POSITIVE: a link whose visible text is a raw report filename
// ("report_final_v2.pdf") — a polluted accessible name announced verbatim. The
// link HAS content, so the floor's link-no-name pass stays silent; only the
// corpus recall layer catches the noisy name. Pattern: 2.4.4-noisy-or-wrong-name
// (common, eligible to flag).

import { Link } from "react-router-dom";

export const Report = () => (
  <Link to="/files/report">report_final_v2.pdf</Link>
);
