// POSITIVE: a link whose accessible name is POLLUTED — the visible text is a raw
// URL ("https://example.com/docs/..."), which a screen reader announces verbatim.
// The link HAS content, so the floor's anchor-has-content / link-no-name passes
// stay silent — this is a NON-FLOOR SC only the corpus recall layer catches.
// Pattern: 2.4.4-noisy-or-wrong-name (common, eligible to flag).

import { Link } from "@mui/material";

export const Docs = () => (
  <Link href="https://example.com/docs/getting-started">
    https://example.com/docs/getting-started
  </Link>
);
