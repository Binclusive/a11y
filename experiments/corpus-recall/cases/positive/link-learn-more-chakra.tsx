// POSITIVE: a generic "learn more" link — has text, so the floor stays silent,
// but the phrase is non-descriptive and typically repeated across a page. Only
// the corpus recall layer catches the non-descriptive name. Pattern:
// 2.4.4-generic-link-text (common, eligible to flag).

import { Link } from "@chakra-ui/react";

export const LearnMore = () => <Link href="/pricing">learn more</Link>;
