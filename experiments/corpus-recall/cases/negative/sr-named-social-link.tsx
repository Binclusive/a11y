// HARD NEGATIVE (G3 resolved renders-own-name): a custom <TwitterLink> that
// renders its OWN `sr-only` name inside the wrapper. The self-closing call site
// looks nameless, so a 2.4.4-social-icon-link-no-name nomination here is a
// precision leak G3 (`renders-own-name`) must veto. The veto fires only when the
// DEFINITION file (sr-named-social-link-def.tsx) is in the same scan so the
// tracer can see the internal name. Exercises G3.
import { TwitterLink } from "./sr-named-social-link-def";

export const Footer = () => <TwitterLink href="https://twitter.com/acme" />;
