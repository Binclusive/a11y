// Link-control fixtures. `Link` (MUI/registry) resolves to an `<a>` host.
// `RouterLink`/`NavLink` (react-router) are recognized as link controls by the
// content pass ONLY — never mapped to host `a` for the structural pass, since
// their destination is on `to`, not `href`.

import { Link } from "@mui/material";
import { Link as RouterLink, NavLink } from "react-router";
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

// react-router icon-only link, no name → FLAGS 2.4.4 (the recall win: this was
// invisible before, since router Link never entered any host map).
export const IconOnlyRouterLink = () => (
  <RouterLink to="/x">
    <Trash />
  </RouterLink>
);

// react-router NavLink with visible text → NO flag.
export const NavLinkWithText = () => <NavLink to="/x">Home</NavLink>;

// react-router link, icon-only but aria-labelled → NO flag.
export const LabelledRouterLink = () => (
  <RouterLink to="/x" aria-label="Delete item">
    <Trash />
  </RouterLink>
);

// react-router link with a DYNAMIC child → NO flag (conservative: content unknowable).
export const DynamicRouterLink = ({ label }: { label: string }) => (
  <RouterLink to="/x">{label}</RouterLink>
);
