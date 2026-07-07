// The real single-host definition the barrel re-exports.
import type * as React from "react";

export interface BarrelButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  loading?: boolean;
}

export const BarrelButton = (props: BarrelButtonProps) => <button {...props} />;
