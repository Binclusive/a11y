// Fixtures for the RESOLVED-HOST skips the deterministic shell must inherit
// (findings #2/#3/#8). Each call site pairs with a hand-built ComponentResolution
// in the test (a Radix Checkbox traced to button[role=checkbox], a shadcn wrapper
// that renders its own name, an input-host wrapper, a non-input component) so we
// can assert the suppressor map / abstentions cover the resolved-host case that
// call-site syntax alone cannot see.

import { ConsentBox } from "@/components/ui/consent-box";
import { CarouselPrevious } from "@/components/ui/carousel";
import { SearchField } from "@/components/ui/search-field";
import { Card } from "@/components/ui/card";

// Resolves to button[role=checkbox] — a toggle reached via TRACE (NOT a
// TOGGLE_NAMES match, so it exercises the resolved-host toggle path, enforce.ts
// `isToggleRole(resolved.role)`). The call site looks like a bare nameless
// button, but enforce skips it (toggle role). Self-closing, no name.
export const RadixToggle = () => <ConsentBox />;

// Resolves to a host that renders its OWN internal sr-only name — named even
// though the self-closing call site looks empty. enforce skips it.
export const OwnNameWrapper = () => <CarouselPrevious />;

// Resolves to an input host with a name-exempt `type` — enforce exempts it.
export const ExemptInputWrapper = () => <SearchField type="submit" />;

// A capitalized component that resolves to NO input host (a plain card) but
// carries a `type` prop. The OLD over-broad gate marked EVERY capitalized
// component with a name-exempt type; the correct gate must NOT mark this one.
export const NonInputWithType = () => <Card type="submit" />;
