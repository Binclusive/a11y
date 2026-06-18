// POSITIVE: a generic "view more" link — has text, so the floor's
// anchor-has-content pass is satisfied and stays silent, but the phrase names
// nothing about the destination out of context. Only the corpus recall layer
// catches the non-descriptive name. Pattern: 2.4.4-generic-link-text (common,
// eligible to flag).

import { Link } from "@mui/material";

export const ViewMore = () => <Link href="/gallery">view more</Link>;
