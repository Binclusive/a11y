// Two distinct SCs so the floor and the recall self-check are disjoint: the
// <img> missing alt trips a 1.1.1 floor finding, while the generic-text <Link>
// (visible name "read more") is a floor-MISSED 2.4.4 the corpus grounds. The
// SC-disjoint filter keeps 2.4.4 in the advisory (the floor is silent on it).
import { Link } from "@mui/material";

export function Card() {
  return (
    <div>
      <img src="/x.png" />
      <Link href="/learn">read more</Link>
    </div>
  );
}
