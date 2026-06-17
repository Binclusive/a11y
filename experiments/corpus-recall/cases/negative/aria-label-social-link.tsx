// HARD NEGATIVE: the SAME social icon link as the positive, but with an explicit
// aria-label — it IS named. A 2.4.4-social-icon-link-no-name nomination here is
// a misclassification of correctly-named code. The recall layer must surface
// ZERO findings (G4 abstention / no genuine failure).

import { Link } from "@mui/material";
import { Twitter } from "lucide-react";

export const Social = () => (
  <Link href="https://twitter.com/binclusive" aria-label="Binclusive on Twitter">
    <Twitter />
  </Link>
);
