// POSITIVE: a link whose visible text is a full https URL announced verbatim,
// character by character, by a screen reader — a polluted accessible name. The
// link HAS content, so the floor's link-no-name pass stays silent; only the
// corpus recall layer catches the noisy name. Pattern: 2.4.4-noisy-or-wrong-name
// (common, eligible to flag).

import { Link } from "@mui/material";

export const Url = () => (
  <Link href="/r">https://www.example.com/articles/2024/07/index.html</Link>
);
