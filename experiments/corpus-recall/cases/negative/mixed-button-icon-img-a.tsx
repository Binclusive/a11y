// HARD NEGATIVE (R4 — the F6 scenario re-proven): a file mixing an icon-only
// <IconButton> and a bare <button> right next to a well-described <img> and a
// descriptively-named raw <a>. R4's `img` / `a` table rows must NOT bleed into
// the button/icon context: a tag resolves to EXACTLY the ids under its key, so
// no <img>/<a> pattern can land on the button, and the <IconButton> (an opaque
// component, not an intrinsic) never enters R4 at all. The img has a good alt
// and the anchor has descriptive text, so even their own rows surface nothing.
// The recall layer must surface ZERO.

import { IconButton } from "@mui/material";
import { Trash } from "lucide-react";

export const Toolbar = () => (
  <div>
    <IconButton aria-label="Delete item">
      <Trash />
    </IconButton>
    <button type="button">Save changes</button>
    <img src="/avatar.jpg" alt="Photo of Jane Doe, account owner" />
    <a href="/settings">Open your account settings</a>
  </div>
);
