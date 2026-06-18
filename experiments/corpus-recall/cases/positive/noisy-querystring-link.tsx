// POSITIVE: a link whose visible text is a file path with a query string —
// a polluted accessible name a screen reader reads out verbatim. The link HAS
// content, so the floor's link-no-name pass is satisfied; only the corpus recall
// layer catches the noisy name. Pattern: 2.4.4-noisy-or-wrong-name (common,
// eligible to flag).

import { Link } from "@chakra-ui/react";

export const Path = () => (
  <Link href="/d">/assets/files/export.csv?token=abc123&format=raw</Link>
);
