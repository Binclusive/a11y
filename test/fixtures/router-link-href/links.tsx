// Issue #33 fixture. A user maps react-router `Link`/`NavLink` → host `a` in
// the co-located `binclusive.json`. The destination rides `to`, not `href`, so
// without the `specialLink: ['to']` alias `anchor-is-valid` false-positives on
// EVERY valid router link (the 30/30 FP flood on kamp-us/phoenix).
//
// With the alias: a valid `to` satisfies the href requirement (NO finding),
// while a genuinely empty `to=""` / `to="#"` still flags (the alias narrows the
// rule, it does not disable it).

import { Link, NavLink } from "react-router";

// Valid destination — NO `anchor-is-valid` finding (the FP this fix removes).
export const ValidLink = () => <Link to="/pano">Panoya git</Link>;

// Valid NavLink destination — NO finding.
export const ValidNavLink = () => <NavLink to="/sozluk">Sözlük</NavLink>;

// Empty destination — STILL flags `anchor-is-valid` (invalid-href aspect).
export const EmptyToLink = () => <Link to="">Boş</Link>;

// Hash-only destination — STILL flags `anchor-is-valid` (invalid-href aspect).
export const HashToLink = () => <Link to="#">Diyez</Link>;
