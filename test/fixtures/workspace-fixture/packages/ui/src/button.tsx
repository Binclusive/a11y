// A workspace-package wrapper that forwards props to a single <button> host.
// Resolved via `@acme/ui/button` -> exports "./*": "./src/*.tsx".
import type * as React from "react";

export const Button = (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
  <button type="button" {...props} />
);
