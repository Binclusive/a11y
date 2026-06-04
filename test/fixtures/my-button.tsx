// A synthetic, homegrown wrapper — deliberately NOT @b8e/design and NOT in the
// registry. Proves the source-tracer infers wrapper->host from arbitrary source.
import type * as React from "react";

export const MyButton = (props: React.ComponentProps<"button">) => <button {...props} />;

// A wrapper that does NOT forward props -> must stay OPAQUE (conservative gate).
export const NoForwardButton = () => <button type="button">click</button>;

// A wrapper rendering two different hosts -> ambiguous -> must stay OPAQUE.
export const Ambiguous = (props: { wide: boolean } & React.ComponentProps<"a">) =>
  props.wide ? <a {...props} /> : <button type="button">x</button>;
