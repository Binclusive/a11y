// #5 — a homegrown toggle that renders `<button role="checkbox">`. The host is
// `button`, but the static `role="checkbox"` literal makes it a TOGGLE: the
// trace must CAPTURE the role so downstream treats it as a toggle (skipped /
// kept out of the jsx-a11y map), not a bare button. A bare `<MyToggle>` with
// `aria-invalid` and no name would otherwise fire role-support / no-name rules
// against `button` — false positives, since both are valid on `role="checkbox"`.
import type * as React from "react";

export const RoleCheckbox = (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
  <button role="checkbox" {...props} />
);

export const RoleSwitch = (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
  <button role="switch" {...props} />
);

// A plain button toggle is NOT a toggle role — a static `role="button"` (or no
// role) leaves behavior unchanged: still a normal button host, no role carried.
export const PlainButton = (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
  <button {...props} />
);

// A DYNAMIC role is unknowable — captured as no role (uncertain → skip), so the
// host reads as a bare button exactly as before.
export const DynamicRole = (
  props: React.ButtonHTMLAttributes<HTMLButtonElement> & { r?: string },
) => {
  const { r, ...rest } = props;
  return <button role={r} {...rest} />;
};
