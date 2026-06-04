import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { traceComponent } from "../src/source-trace";

/**
 * Radix `Slot` transparency — the biggest shadcn coverage win.
 *
 * The canonical shadcn primitive renders `asChild ? <Slot {...props}/> :
 * <button {...props}/>`, host-tag set `{Slot, button}` (size 2). Without
 * collapsing the transparent Slot the tracer refuses (size !== 1) and the whole
 * design system goes opaque. These pin: Slot collapses, the sibling host wins,
 * and a genuinely composite component (no Slot) STAYS opaque.
 */

const here = dirname(fileURLToPath(import.meta.url));
const consumer = join(here, "fixtures", "consumer.tsx");

describe("Radix Slot transparency", () => {
  it("collapses `asChild ? <Slot/> : <button/>` (if/else form) to button", () => {
    expect(traceComponent("./slot-button", "SlotButton", consumer)).toEqual({
      host: "button",
      via: "trace",
      rendersOwnName: false,
    });
  });

  it('collapses `const Tag = asChild ? Slot : "a"` (ternary form) to a', () => {
    expect(traceComponent("./slot-button", "SlotLink", consumer)).toEqual({
      host: "a",
      via: "trace",
      rendersOwnName: false,
    });
  });

  it("keeps a genuinely composite component ({div, span}, no Slot) OPAQUE", () => {
    // Over-collapse guard: two distinct real hosts must NOT resolve.
    expect(traceComponent("./slot-button", "Composite", consumer)).toBeNull();
  });

  it("does NOT treat a non-Radix local named `Slot` as transparent", () => {
    // FakeSlot renders {MySlot (from ./my-slot), div}. MySlot is not the Radix
    // Slot, so it carries a host and the set stays size 2 -> opaque. Proves we
    // key on the import origin, not the bare identifier name.
    expect(traceComponent("./slot-button", "FakeSlot", consumer)).toBeNull();
  });
});
