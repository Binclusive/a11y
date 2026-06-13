// Mirrors the shadcn/ui barrel shape the senchabot monorepo exposed — the case
// that sent a whole design system into `declare`. Radix primitives are
// re-published as bare VALUE ALIASES (`const X = NS.Member`) and single-tag
// forwardRef wrappers; a native heading forwards its children through a
// `{...props}` spread. These drive two regression guards:
//   - barrel-origin → trusted   (traceWrapperOrigin follows the alias to Radix)
//   - {...props} content-FP      (spreadChildrenLineRanges suppresses has-content)
import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";

// Value alias: a host-LESS Radix container re-exported under a local name. The
// tracer can't pin a host, so without origin-following it falls into `declare`.
export const Dialog = DialogPrimitive.Root;

// Single-tag, props-forwarding forwardRef wrapper around a host-less Radix
// primitive — the same thin shape, the inner element's module is the origin.
export const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>((props, ref) => <DialogPrimitive.Title ref={ref} {...props} />);
DialogTitle.displayName = "DialogTitle";

// Prop-spread native heading: the consumer passes the title text as children,
// which flow in through `{...props}` — invisible to jsx-a11y heading-has-content.
export const CardTitle = React.forwardRef<
  HTMLHeadingElement,
  React.HTMLAttributes<HTMLHeadingElement>
>(({ className, ...props }, ref) => <h3 ref={ref} className={className} {...props} />);
CardTitle.displayName = "CardTitle";

// A genuine MULTI-ELEMENT composite (Portal + Overlay + Content). NOT thin — it
// must stay `declare`, never be promoted to trusted, even though every tag is
// Radix. The over-promotion guard.
export function DialogPanel({ children }: { children: React.ReactNode }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay />
      <DialogPrimitive.Content>{children}</DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
