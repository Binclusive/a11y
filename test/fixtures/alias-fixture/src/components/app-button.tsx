// The repo's OWN button, reached through the `@app/*` tsconfig alias. It
// forwards props to a single <button>, so it traces to a host — but because it
// is reached through an own-source alias it must NOT count as a design system.
import type * as React from "react";

export const AppButton = (props: React.ComponentProps<"button">) => <button {...props} />;
