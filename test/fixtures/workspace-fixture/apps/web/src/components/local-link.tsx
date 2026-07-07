// A path-aliased local wrapper (`@/components/local-link`) that forwards props
// to a single <a> host. Resolved via tsconfig paths "@/*": ["src/*"].
import type * as React from "react";

export const LocalLink = (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
  <a {...props} />
);
