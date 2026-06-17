// HARD NEGATIVE: the SAME <Link> as the icon-link positive, but with clear,
// descriptive visible text. It IS named and descriptive — a 2.4.4-link-no-name
// OR 2.4.4-generic-link-text nomination here is a false positive on correct
// code. The recall layer must surface ZERO findings.

import { Link } from "@mui/material";

export const ProfileLink = () => <Link href="/profile">View your profile</Link>;
