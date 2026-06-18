// POSITIVE: a link whose visible text is a raw, deep path segment
// ("/very/long/path/segment") — a polluted accessible name a screen reader reads
// out slash by slash. The link HAS content, so the floor's link-no-name pass
// stays silent; only the corpus recall layer catches the noisy name. Pattern:
// 2.4.4-noisy-or-wrong-name (common, eligible to flag).

import { Link } from "@mui/material";

export const Path = () => (
  <Link href="/p">/very/long/path/segment</Link>
);
