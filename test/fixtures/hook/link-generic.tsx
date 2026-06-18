// A floor-CLEAN file (the Link has text, so jsx-a11y/enforce stay silent) that
// the RECALL self-check should speak up on: the visible name "click here" is
// generic — a floor-missed 2.4.4 failure the corpus grounds. Imported <Link>
// resolves to host `a`, so retrieveSlice R1 grounds the link-text patterns.
import { Link } from "@mui/material";

export function Promo() {
  return <Link href="/pricing">click here</Link>;
}
