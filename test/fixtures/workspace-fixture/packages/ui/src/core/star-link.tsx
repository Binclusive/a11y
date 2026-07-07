// Definition reached only through a STAR re-export (`export * from ...`).
import type * as React from "react";

export const StarLink = (props: React.ComponentProps<"a">) => <a {...props} />;
