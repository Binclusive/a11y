// POSITIVE: a generic "this link" anchor — descriptive-looking but contentless
// out of context. The link HAS text, so the floor stays silent; only the corpus
// recall layer catches the non-descriptive name. Pattern: 2.4.4-generic-link-text
// (common, eligible to flag).

import { Link } from "@mui/material";

export const Here = () => <Link href="/terms">this link</Link>;
