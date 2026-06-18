// POSITIVE: a generic "details" link — has content so the floor's
// anchor-has-content pass is satisfied, but "details" conveys nothing about the
// destination out of context. Only the corpus recall layer catches it. Pattern:
// 2.4.4-generic-link-text (common, eligible to flag).

import { Link } from "@mui/material";

export const Det = () => <Link href="/p/9">details</Link>;
