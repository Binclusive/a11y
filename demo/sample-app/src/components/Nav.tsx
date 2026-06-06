// Nav — exercises the NEW react-router recall. `<Link>` from "react-router"
// is recognized as a link control (an <a>) with ZERO config, so an icon-only
// link is flagged on the COLD scan — no design system declaration needed.
import { Link, NavLink } from "react-router";
import { GearIcon } from "lucide-react";

export function Nav() {
  return (
    <nav aria-label="Primary">
      {/* CORRECT: a link with visible text — zero false positive expected */}
      <Link to="/">Home</Link>

      {/* CORRECT: a NavLink with visible text */}
      <NavLink to="/gallery">Gallery</NavLink>

      {/* BUG: icon-only react-router <Link> with no accessible name — 4.1.2.
          Recognized as an <a> control on the COLD scan with no config. */}
      <Link to="/settings">
        <GearIcon />
      </Link>
    </nav>
  );
}
