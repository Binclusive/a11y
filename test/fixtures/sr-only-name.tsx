// The shadcn-vendored carousel-arrow shape (a real Saleor-storefront false
// positive). A `forwardRef` wrapper resolves to a host `button` but renders its
// OWN static accessible name internally — an `sr-only` span carrying real text
// beside an icon. The name is invisible at the self-closing call site, so the
// enforce no-name check must NOT fire: the trace captures `rendersOwnName`.
import * as React from "react";
import { InnerButton } from "./sr-only-inner-button";

// Stand-in icon — content, not a control. Carries no accessible name itself.
const ChevronLeft = (props: React.SVGProps<SVGSVGElement>) => <svg {...props} />;

// Host = <button> directly. The `sr-only` span gives it a static name.
export const SrOnlyButton = React.forwardRef<
  HTMLButtonElement,
  React.ComponentProps<"button">
>((props, ref) => (
  <button ref={ref} {...props}>
    <ChevronLeft className="h-4 w-4" />
    <span className="sr-only">Previous slide</span>
  </button>
));
SrOnlyButton.displayName = "SrOnlyButton";

// The EXACT carousel shape: the name lives in THIS wrapper's body, wrapped
// around an inner CAPITALIZED host component (imported, like shadcn's `Button`)
// the tracer recurses into. The name must propagate across the recursive hop,
// not just a direct-host render.
export const CarouselArrow = React.forwardRef<
  HTMLButtonElement,
  React.ComponentProps<typeof InnerButton>
>((props, ref) => (
  <InnerButton ref={ref} {...props}>
    <ChevronLeft className="h-4 w-4" />
    <span className="sr-only">Next slide</span>
  </InnerButton>
));
CarouselArrow.displayName = "CarouselArrow";

// A button named by a static `aria-label` literal on the host (no children).
export const AriaLabelButton = React.forwardRef<
  HTMLButtonElement,
  React.ComponentProps<"button">
>((props, ref) => (
  <button ref={ref} aria-label="Close" {...props}>
    <ChevronLeft className="h-4 w-4" />
  </button>
));
AriaLabelButton.displayName = "AriaLabelButton";

// THE OVER-SUPPRESSION GUARD: a genuinely-nameless icon-only button wrapper.
// No sr-only span, no aria-label, no text — only an icon child. This one MUST
// still flag enforce/button-no-name; `rendersOwnName` stays false.
export const NamelessIconButton = React.forwardRef<
  HTMLButtonElement,
  React.ComponentProps<"button">
>((props, ref) => (
  <button ref={ref} {...props}>
    <ChevronLeft className="h-4 w-4" />
  </button>
));
NamelessIconButton.displayName = "NamelessIconButton";
