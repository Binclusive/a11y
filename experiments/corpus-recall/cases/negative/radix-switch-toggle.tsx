// HARD NEGATIVE (G3 resolved toggle-role): a Radix-style <SwitchRoot> the tracer
// resolves to `button[role=switch]` — a TOGGLE the floor deliberately does NOT
// state-check. The call site looks state-less, so a recall nomination of
// 4.1.2-selected-or-current-state-missing here is a precision leak G3
// (`toggle-role`) must veto. The veto fires only when the DEFINITION file
// (radix-switch-toggle-def.tsx) is in the same scan so the role resolves.
// Exercises G3.
import { SwitchRoot } from "./radix-switch-toggle-def";

export const DarkMode = () => <SwitchRoot />;
