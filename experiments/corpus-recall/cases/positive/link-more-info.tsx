// POSITIVE: a generic "more info" link — has text, so the floor stays silent,
// but the phrase is non-descriptive and typically repeated across a page. Only
// the corpus recall layer catches it. Pattern: 2.4.4-generic-link-text (common,
// eligible to flag).

import { Link } from "@mui/material";

export const Info = () => <Link href="/faq">more info</Link>;
