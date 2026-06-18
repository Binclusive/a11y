// POSITIVE: a generic "read more" link — has text so the floor's
// anchor-has-content pass stays silent, but the phrase is meaningless out of
// context. Only the corpus recall layer catches it. Pattern:
// 2.4.4-generic-link-text (common, eligible to flag).

import { Link } from "@mui/material";

export const More = () => <Link href="/news/12">read more</Link>;
