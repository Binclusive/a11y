// POSITIVE: a generic "click here" router link — has text so the floor's
// anchor-has-content pass stays silent, but the phrase conveys nothing out of
// context. Only the corpus recall layer catches the non-descriptive name.
// Pattern: 2.4.4-generic-link-text (common, eligible to flag).

import { Link } from "react-router-dom";

export const Help = () => <Link to="/help">click here</Link>;
