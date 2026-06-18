// POSITIVE: a link whose visible text is a raw breadcrumb path
// ("Home / Products / Item") — a polluted accessible name a screen reader reads
// with every slash. The link HAS content, so the floor's link-no-name pass stays
// silent; only the corpus recall layer catches the noisy name. Pattern:
// 2.4.4-noisy-or-wrong-name (common, eligible to flag).

import { Link } from "@chakra-ui/react";

export const Crumb = () => (
  <Link href="/i">Home / Products / Item</Link>
);
