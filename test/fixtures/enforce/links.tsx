// Link-control fixtures. `Link` (MUI/registry) resolves to an `<a>` host.

import { Link } from "@mui/material";
import { Trash } from "lucide-react";

// Link with text → NO flag.
export const LinkWithText = () => <Link href="/x">Home</Link>;

// Icon-only link, no name → FLAGS 2.4.4.
export const IconOnlyLink = () => (
  <Link href="/x">
    <Trash />
  </Link>
);

// Named icon-only link → NO flag.
export const LabelledIconLink = () => (
  <Link href="/x" aria-label="Delete item">
    <Trash />
  </Link>
);
