// Issue #33 regression — ALIASED import (PR #35 review finding). The repo
// imports react-router `Link` under a LOCAL alias (`RouterLink`) and maps that
// alias → host `a` in the co-located `binclusive.json`. The router-link gate
// must recognize the link by its ORIGINAL export name (`Link`), NOT the local
// alias (`RouterLink`) — otherwise `specialLink: ['to']` never arms and the
// `anchor-is-valid` FP flood (the exact thing #33 fixed) silently returns.
//
// Same contract as the non-aliased fixture: a valid `to` produces NO finding,
// an empty/hash `to` STILL flags (the alias narrows the rule, never disables it).

import { Link as RouterLink } from "react-router";

// Valid destination — NO `anchor-is-valid` finding (the FP this fix removes).
export const ValidLink = () => <RouterLink to="/pano">Panoya git</RouterLink>;

// Empty destination — STILL flags `anchor-is-valid` (invalid-href aspect).
export const EmptyToLink = () => <RouterLink to="">Boş</RouterLink>;
