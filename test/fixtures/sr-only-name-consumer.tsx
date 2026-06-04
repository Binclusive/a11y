// Self-closing call sites that look nameless. The wrappers resolve to host
// `button`, but three of them render their OWN static name internally (sr-only
// span / aria-label) — those must NOT flag enforce/button-no-name. Only
// `NamelessIconButton` (icon-only, no internal name) is genuinely nameless and
// MUST still flag — the over-suppression guard.
import {
  AriaLabelButton,
  CarouselArrow,
  NamelessIconButton,
  SrOnlyButton,
} from "./sr-only-name";

export function SrOnlyNameConsumer() {
  return (
    <div>
      <SrOnlyButton />
      <CarouselArrow />
      <AriaLabelButton />
      <NamelessIconButton />
    </div>
  );
}
