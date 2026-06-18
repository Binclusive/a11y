// POSITIVE: a generic "click" link — has text, so the floor's anchor-has-content
// pass is satisfied and stays silent, but "click" describes an action, not the
// destination. Only the corpus recall layer catches the non-descriptive name.
// Pattern: 2.4.4-generic-link-text (common, eligible to flag).

import { Link } from "@mui/material";

export const Click = () => <Link href="/signup">click</Link>;
