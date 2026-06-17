// HARD NEGATIVE (S1, finding #8): a shadcn-style `<PrevSlideButton>` that renders
// its OWN `sr-only` name inside the wrapper. The self-closing call site looks
// nameless, so a 4.1.2-button-no-name nomination here is a precision leak G3
// (`renders-own-name`) must veto. The veto only fires when the DEFINITION file
// (sr-only-named-control-def.tsx) is in the same scan so the tracer can see the
// internal name and capture `rendersOwnName` — the cross-file resolution #6
// restores. Before #6 the eval scanned this file alone, the wrapper stayed
// opaque, and the decoy would have leaked. Exercises G3.
import { PrevSlideButton } from "./sr-only-named-control-def";

export const Carousel = () => <PrevSlideButton />;
