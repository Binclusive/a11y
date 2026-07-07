// The inner host primitive the carousel arrow forwards to — a plain forwarding
// `forwardRef` button, imported by the wrapper (mirrors shadcn's `./button`).
import * as React from "react";

export const InnerButton = React.forwardRef<HTMLButtonElement, React.ComponentProps<"button">>(
  (props, ref) => <button ref={ref} {...props} />,
);
InnerButton.displayName = "InnerButton";
