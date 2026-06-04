// A forwardRef wrapper rendering a single host with prop-forwarding.
// Proves the tracer unwraps forwardRef(fn) and reads the inner render.
import * as React from "react";

export const FancyLink = React.forwardRef<HTMLAnchorElement, React.ComponentProps<"a">>(
  (props, ref) => <a ref={ref} {...props} />,
);
FancyLink.displayName = "FancyLink";
