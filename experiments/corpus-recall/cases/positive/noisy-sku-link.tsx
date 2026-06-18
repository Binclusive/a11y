// POSITIVE: a link whose visible text is an ALL-CAPS product SKU — a polluted
// accessible name a screen reader spells out verbatim, with no human meaning.
// The link HAS content, so the floor's link-no-name pass is satisfied; only the
// corpus recall layer catches the noisy name. Pattern: 2.4.4-noisy-or-wrong-name
// (common, eligible to flag).

import { Link } from "@mui/material";

export const Sku = () => <Link href="/p/x">SKU-9F3A-XL-BLK-2024</Link>;
