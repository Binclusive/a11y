// A barrel like Cal.com's `@acme/ui/components/button`: it RE-EXPORTS the real
// component from a sibling file (named re-export), so the tracer must follow
// the hop to the definition rather than stop here and report opaque.
export { BarrelButton } from "./BarrelButton";
export type { BarrelButtonProps } from "./BarrelButton";
