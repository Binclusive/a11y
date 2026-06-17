// POSITIVE: a non-descriptive link ("click here"). This is a NON-FLOOR SC: the
// link HAS text, so jsx-a11y's anchor-has-content is satisfied and the floor
// stays silent — but the text is meaningless out of context. Only the corpus
// recall layer catches generic link text. Pattern: 2.4.4-generic-link-text
// (common, eligible to flag).

import { Link } from "@mui/material";

export const ReadMore = () => <Link href="/article/42">click here</Link>;
