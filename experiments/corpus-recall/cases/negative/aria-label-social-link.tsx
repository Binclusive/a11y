// HARD NEGATIVE: the SAME social icon link as the positive, but with an explicit
// aria-label — it IS named. The floor's enforce pass returns `clean` (a genuinely
// named control: no finding, and NO G4 abstention marker — only unknowable
// content, spread props or dynamic children, records that). A
// 2.4.4-social-icon-link-no-name nomination here would be a false positive on
// correctly-named code; the recall layer must surface ZERO findings. This is the
// named-control precision spine, not a G4 exercise.

import { Link } from "@mui/material";
import { Twitter } from "lucide-react";

export const Social = () => (
  <Link href="https://twitter.com/binclusive" aria-label="Binclusive on Twitter">
    <Twitter />
  </Link>
);
