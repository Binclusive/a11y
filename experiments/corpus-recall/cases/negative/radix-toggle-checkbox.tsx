// HARD NEGATIVE (S1, finding #2): a Radix-style `<CheckboxRoot>` that the tracer
// resolves to `button[role=checkbox]` — a TOGGLE, externally labelled, which the
// floor deliberately does NOT name-check. The call site looks nameless (no text,
// no aria-label), so a 4.1.2-button-no-name nomination here is a precision leak
// G3 (`toggle-role`) must veto. The veto only fires when the DEFINITION file
// (radix-toggle-checkbox-def.tsx) is in the same scan — the cross-file resolution
// #6 restores. Before #6 the eval scanned this file alone, the wrapper stayed
// opaque, no resolved host existed, and the decoy would have leaked. Exercises G3.
import { CheckboxRoot } from "./radix-toggle-checkbox-def";

export const RememberMe = () => <CheckboxRoot />;
