// The DEFINITION half of the rendersOwnName decoy (S1, finding #8). A shadcn-
// style control that resolves to host `button` but renders its OWN static
// accessible name internally — an `sr-only` span beside an icon. The name is
// invisible at the self-closing call site, so the trace captures `rendersOwnName`
// and the resolved-host map marks the call site `renders-own-name`. This file
// MUST be in the scan set for the resolution to happen — the cross-file fact #6
// restores.
import * as React from "react";

// Stand-in icon — content, not a control, carries no accessible name itself.
const ChevronLeft = (props: React.SVGProps<SVGSVGElement>) => <svg {...props} />;

export const PrevSlideButton = React.forwardRef<
  HTMLButtonElement,
  React.ComponentProps<"button">
>((props, ref) => (
  <button ref={ref} {...props}>
    <ChevronLeft className="h-4 w-4" />
    <span className="sr-only">Previous slide</span>
  </button>
));
PrevSlideButton.displayName = "PrevSlideButton";
