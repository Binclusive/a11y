// POSITIVE: a generic "find out more" router link — has text, so the floor stays
// silent, but the phrase conveys nothing about the destination out of context.
// Only the corpus recall layer catches the non-descriptive name. Pattern:
// 2.4.4-generic-link-text (common, eligible to flag).

import { Link } from "react-router-dom";

export const FindOut = () => <Link to="/about">find out more</Link>;
