// The DEFINITION half of the rendersOwnName link decoy. A social-icon link
// wrapper that resolves to host `a` but renders its OWN static accessible name
// internally — an `sr-only` span beside the icon. The name is invisible at the
// self-closing call site, so the trace captures `rendersOwnName` and the
// resolved-host map marks the call site `renders-own-name`. This file MUST be in
// the scan set for the resolution to happen.
import * as React from "react";

// Stand-in glyph — content, not a control, carries no accessible name itself.
const TwitterGlyph = (props: React.SVGProps<SVGSVGElement>) => <svg {...props} />;

export const TwitterLink = (props: React.ComponentProps<"a">) => (
  <a {...props}>
    <TwitterGlyph className="h-4 w-4" />
    <span className="sr-only">Follow us on Twitter</span>
  </a>
);
