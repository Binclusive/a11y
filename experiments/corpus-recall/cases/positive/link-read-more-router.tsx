// POSITIVE: a generic "read more" router link — has text, so the floor stays
// silent, but the phrase is meaningless out of context and usually repeated per
// card. Only the corpus recall layer catches the non-descriptive name. Pattern:
// 2.4.4-generic-link-text (common, eligible to flag).

import { Link } from "react-router-dom";

export const ReadMore = () => <Link to="/blog/7">read more</Link>;
