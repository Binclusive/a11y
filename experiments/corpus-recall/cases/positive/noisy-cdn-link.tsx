// POSITIVE: a link whose visible text is a raw, query-laden CDN URL announced
// verbatim by a screen reader — a polluted accessible name. The link HAS
// content, so the floor's link-no-name pass stays silent; only the corpus recall
// layer catches the noisy name. Pattern: 2.4.4-noisy-or-wrong-name (common,
// eligible to flag).

import { Link } from "@mui/material";

export const Raw = () => (
  <Link href="/dl">https://cdn.example.com/a/b/c?id=42&ref=home</Link>
);
