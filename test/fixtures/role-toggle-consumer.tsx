// Uses the homegrown toggles + a plain button so resolveComponents can be
// asserted: the role='checkbox'/'switch' hosts must be KEPT OUT of the jsx-a11y
// map (treated as toggles, not bare buttons — this is what kills the Radix-role
// structural false positive), while the plain button is mapped as usual.
import { PlainButton, RoleCheckbox, RoleSwitch } from "./role-toggle";

export function RoleToggleConsumer() {
  return (
    <div>
      <RoleCheckbox aria-invalid={true} />
      <RoleSwitch />
      <PlainButton>Save</PlainButton>
    </div>
  );
}
