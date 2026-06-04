// Fixtures locking the name-heuristic module gate (hardening-3 #1 + #4).
//
// The name heuristic must fire ONLY when the component's import module is a
// GUARANTEED design system. A bare `Button`/`Link` from an UNKNOWN module
// (react-admin, a custom re-export) is a guess, not evidence, and must NOT flag
// — that is the react-admin mass-FP this gate kills.

// --- UNKNOWN module: name-only match must NOT fire ---

// react-admin re-exports Button (named by a `label=` prop, no children) and
// TextField (a DISPLAY field that renders a <span>, not an input). Neither is a
// guaranteed library, so the name heuristic must not claim them.
import { Button as RaButton, TextField as RaField } from "react-admin";

// Icon-only react-admin Button, no name → MUST NOT flag (unknown module).
export const RaIconButton = () => (
  <RaButton>
    <svg />
  </RaButton>
);

// react-admin Button named by `label=` → MUST NOT flag (and label= clears it too).
export const RaLabelledButton = () => <RaButton label="Import" />;

// react-admin display TextField → MUST NOT flag (not a real input; unknown module).
export const RaDisplayField = () => <RaField source="name" />;

// A bare custom Link from an unknown module, icon-only → MUST NOT flag.
import { Link as MysteryLink } from "some-unknown-router";
export const UnknownIconLink = () => (
  <MysteryLink href="/x">
    <svg />
  </MysteryLink>
);

// --- GUARANTEED module: name-only match MUST fire ---

// Mantine ActionIcon is its icon-only button. Opaque (not in the registry), so
// it reaches ONLY via the name heuristic — and @mantine is guaranteed, so it
// fires. Icon-only + no name → FLAGS 4.1.2 (the WindowPet FN this fixes).
import { ActionIcon } from "@mantine/core";
export const NamelessActionIcon = () => (
  <ActionIcon>
    <svg />
  </ActionIcon>
);

// Same ActionIcon WITH an aria-label → MUST NOT flag.
export const LabelledActionIcon = () => (
  <ActionIcon aria-label="Settings">
    <svg />
  </ActionIcon>
);
