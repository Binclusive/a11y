// #257 — icon-only RAW intrinsic <button> slips both passes. jsx-a11y's
// button-has-accessible-name declines on a custom-element child, so an icon-only
// bare <button> with no name goes uncaught — while the identical <Button> wrapper
// is flagged. These fixtures mirror the exact shapes from the confirmed repros
// (formbricks/formbricks, continuedev/continue) plus the precision negatives.
// Each raw <button> carries a unique className so a test can locate its line.

import { Button } from "@mui/material";
import { XIcon, EllipsisVerticalIcon, GripVerticalIcon } from "lucide-react";

// --- POSITIVES: icon-only raw <button>, no accessible name → FLAGS 4.1.2 ---

// continuedev/continue gui/src/components/DeprecationBanner.tsx:46 shape.
export const RawIconOnlyDismiss = () => (
  <button onClick={() => {}} className="pos-dismiss">
    <XIcon className="h-3.5 w-3.5" />
  </button>
);

// formbricks column-settings-dropdown.tsx:26 shape.
export const RawIconOnlyMenu = () => (
  <button className="pos-menu">
    <EllipsisVerticalIcon />
  </button>
);

// formbricks data-table-header.tsx:54 shape.
export const RawIconOnlyDrag = () => (
  <button className="pos-drag">
    <GripVerticalIcon />
  </button>
);

// Bare <svg> icon child, no name → FLAGS (svg is always an icon, carries no text).
export const RawSvgOnly = () => (
  <button className="pos-svg">
    <svg viewBox="0 0 24 24" />
  </button>
);

// Genuinely empty <button></button> → FLAGS (jsx-a11y would also fire here; the
// dedupe path collapses the pair — asserted below).
export const RawEmpty = () => <button className="pos-empty" />;

// --- NEGATIVES: named / unknowable raw <button> → NO flag (precision) ---

// Visible text child → named → NO flag.
export const RawWithText = () => <button className="neg-text">Save</button>;

// aria-label → named → NO flag.
export const RawAriaLabel = () => (
  <button aria-label="Dismiss" className="neg-arialabel">
    <XIcon />
  </button>
);

// title prop → named → NO flag.
export const RawTitled = () => (
  <button title="Dismiss" className="neg-title">
    <XIcon />
  </button>
);

// sr-only labelled child (a non-icon element) → content unknowable → NO flag.
export const RawSrOnly = () => (
  <button className="neg-sronly">
    <span className="sr-only">Dismiss</span>
    <XIcon />
  </button>
);

// The ICON child itself carries the name — the #257 boundary. The aria-label on
// <XIcon> flows up to the button, so it is NOT nameless → NO flag (abstain).
export const RawIconNamed = () => (
  <button className="neg-iconnamed">
    <XIcon aria-label="Dismiss" />
  </button>
);

// <svg><title> names the icon (and thus the button) → NO flag.
export const RawSvgTitled = () => (
  <button className="neg-svgtitled">
    <svg viewBox="0 0 24 24">
      <title>Dismiss</title>
    </svg>
  </button>
);

// Spread props could carry aria-label → content unknowable → NEVER flag.
export const RawSpread = (props: Record<string, unknown>) => (
  <button {...props} className="neg-spread">
    <XIcon />
  </button>
);

// Dynamic child (computed) → could render text → NEVER flag.
export const RawDynamicChild = ({ label }: { label: string }) => (
  <button className="neg-dynamic">{label}</button>
);

// --- the wrapper parity anchor: the identical <Button> wrapper still fires ONCE ---

// Same icon-only shape as RawIconOnlyDismiss, but as a design-system <Button>.
// This was ALREADY caught before #257; it must still fire exactly once (no
// double-report against the intrinsic path).
export const WrappedIconOnly = () => (
  <Button>
    <XIcon />
  </Button>
);
