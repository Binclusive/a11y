// An own-code wrapper reached through a CONDITIONAL `imports` entry
// (`#lib/*` -> { types, import, default }). The resolver must pick the runtime
// target (`default`/`import`), never the `types` `.d.ts`. Forwards to a single
// <a> host so the tracer resolves it to a link.
import type * as React from "react";

export const AppLink = (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} />;
