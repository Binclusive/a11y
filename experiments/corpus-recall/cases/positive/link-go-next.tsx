// POSITIVE: a generic "go" link — has text, so the floor's anchor-has-content
// pass is satisfied, but "go" gives a screen-reader user no idea of the target.
// Only the corpus recall layer catches the non-descriptive name. Pattern:
// 2.4.4-generic-link-text (common, eligible to flag).

import Link from "next/link";

export const Go = () => <Link href="/checkout">go</Link>;
