// The canonical shadcn primitive: `asChild ? <Slot {...props}/> : <button {...props}/>`.
// Host-tag set is {Slot, button}; the Radix `Slot` is a transparent pass-through
// (renders AS its child), so it must collapse to {button}. Slot is identified by
// its import from "@radix-ui/react-slot", NOT by the bare name.
import { Slot } from "@radix-ui/react-slot";
import * as React from "react";

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  asChild?: boolean;
}

// if/else early-return form (documenso/shadcn): two return paths, {Slot, button}.
export const SlotButton = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ asChild = false, ...props }, ref) => {
    if (asChild) {
      return <Slot ref={ref} {...props} />;
    }
    return <button ref={ref} {...props} />;
  },
);

// `const Tag = asChild ? Slot : "a"` ternary form (the cal.com Section shape).
export const SlotLink = ({ asChild, ...props }: { asChild?: boolean } & React.ComponentProps<"a">) => {
  const Tag = asChild ? Slot : "a";
  return <Tag {...props} />;
};

// A genuinely COMPOSITE component: renders {div, span}, no Slot — must STAY OPAQUE.
// Guard against over-collapsing every two-host component.
export const Composite = (props: { children?: React.ReactNode }) => {
  if (Math.random() > 0.5) {
    return <div {...props} />;
  }
  return <span {...props} />;
};

// A component that names a NON-Radix local `Slot` (e.g. its own layout slot) and
// renders {Slot, div} — must STAY OPAQUE because this Slot has no pass-through
// semantics. Proves we key on the import origin, not the bare name.
import { Slot as MySlot } from "./my-slot";

export const FakeSlot = (props: { children?: React.ReactNode }) => {
  if (Math.random() > 0.5) {
    return <MySlot {...props} />;
  }
  return <div {...props} />;
};
