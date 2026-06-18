// POSITIVE: a link whose visible text is the literal string "undefined" — a
// data-binding bug leaking into the accessible name, announced verbatim. The
// link HAS content, so the floor's link-no-name pass is satisfied; only the
// corpus recall layer catches the noisy/wrong name. Pattern:
// 2.4.4-noisy-or-wrong-name (common, eligible to flag).

import { Link } from "@mui/material";

export const Undef = () => <Link href="/u">undefined</Link>;
