// A library label COMPONENT: it resolves to a <label> host but establishes the
// label/control association internally (here via an injected htmlFor). Mapping
// it to bare `label` would make label-has-associated-control fire at every call
// site — a false positive — so resolveComponents counts it as resolved but
// keeps it OUT of the jsx-a11y component map.
import type * as React from "react";

export const FormLabel = (props: React.LabelHTMLAttributes<HTMLLabelElement>) => (
  <label htmlFor="injected-id" {...props} />
);
