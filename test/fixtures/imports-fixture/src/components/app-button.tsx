// An own-code wrapper reached through a package.json `imports` subpath
// (`#app/*` -> `./src/*`). It forwards props to a single <button> host, so the
// tracer can resolve it end-to-end — once `#app/...` resolves to disk.
import type * as React from "react";

export const AppButton = (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
  <button {...props} />
);
