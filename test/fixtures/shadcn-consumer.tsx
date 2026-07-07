// Consumes the shadcn barrel the way senchabot's app code does: importing the
// re-exported primitives through the local barrel, never from @radix-ui direct.
// resolveComponents over this file must bucket Dialog/DialogTitle as `trusted`
// (origin Radix), and DialogPanel as `declare` (a real composite).
import { Dialog, DialogTitle, DialogPanel } from "./shadcn-barrel";

export function ShadcnConsumer() {
  return (
    <Dialog>
      <DialogPanel>
        <DialogTitle>Settings</DialogTitle>
      </DialogPanel>
    </Dialog>
  );
}
