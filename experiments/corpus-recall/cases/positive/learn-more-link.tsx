// POSITIVE: a "Learn more" link — descriptive-looking but non-specific out of
// context (a screen-reader user pulling the link list hears only "Learn more"
// with no target). The link HAS text so the floor stays silent; only the corpus
// recall layer catches non-descriptive link text. Pattern:
// 2.4.4-generic-link-text (common, eligible to flag).

import { Link } from "@mui/material";

export const Promo = () => <Link href="/pricing">Learn more</Link>;
