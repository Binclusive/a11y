// Fixtures for the enforce content check. Each export is a single, isolated
// call-site so a test can assert exactly which control flags (or doesn't).
//
// The design-system imports below are OPAQUE/TRUSTED to the structural pass:
// MUI Button/IconButton, Radix Dialog, Chakra Image — the library guarantees
// their internal structure, so jsx-a11y never sees a host and never flags the
// CONTENT the app passes in. The enforce check recognizes the control TYPE here
// (registry + name) and checks that app-owned content — that's the recall win.

import { Button, Checkbox, IconButton, TextField, Tooltip } from "@mui/material";
import { Image } from "@chakra-ui/react";
import * as Dialog from "@radix-ui/react-dialog";
import { Trash } from "lucide-react";

// --- buttons ---

// Icon-only, no name → FLAGS 4.1.2 (opaque/trusted MUI button — the key win).
export const IconOnlyTrusted = () => (
  <Button>
    <Trash />
  </Button>
);

// Same, but named → NO flag.
export const IconOnlyLabelled = () => (
  <Button aria-label="Delete">
    <Trash />
  </Button>
);

// Text child → NO flag.
export const ButtonWithText = () => <Button>Save</Button>;

// MUI IconButton, icon-only, no name → FLAGS 4.1.2.
export const TrustedIconButton = () => (
  <IconButton>
    <Trash />
  </IconButton>
);

// Empty trusted button, no name → FLAGS 4.1.2.
export const EmptyButton = () => <Button />;

// Icon-only button inside a TITLED Tooltip → NO flag. MUI Tooltip injects the
// title as the child's aria-label at runtime (describeChild=false default), so
// the button IS named — the call site can't see it (the name-ancestor case).
export const TooltipNamedIconButton = () => (
  <Tooltip title="Delete note">
    <IconButton>
      <Trash />
    </IconButton>
  </Tooltip>
);

// Icon-only button inside a Tooltip with NO title → still FLAGS 4.1.2: a
// title-less Tooltip injects no name, so it must not suppress the finding.
export const TooltiplessIconButton = () => (
  <Tooltip>
    <IconButton>
      <Trash />
    </IconButton>
  </Tooltip>
);

// --- images ---

// Chakra Image, no alt, no aria-label → FLAGS 1.1.1.
export const ImageNoAlt = () => <Image src="/x.png" />;

// Decorative empty alt → NO flag (intentional decorative marking).
export const ImageDecorative = () => <Image src="/x.png" alt="" />;

// Alt present → NO flag.
export const ImageWithAlt = () => <Image src="/x.png" alt="A cat" />;

// --- inputs ---

// MUI TextField with a label prop → NO flag.
export const FieldLabelled = () => <TextField label="Email" />;

// --- conservatism guards ---

// Spread props could carry aria-label/alt/id → NEVER flag.
export const SpreadButton = (props: Record<string, unknown>) => (
  <Button {...props}>
    <Trash />
  </Button>
);

// Dynamic child (computed expression) → content unknowable → NEVER flag.
export const DynamicChildButton = ({ label }: { label: string }) => <Button>{label}</Button>;

// Dynamic aria-label → could be a real name → NEVER flag.
export const DynamicLabelButton = ({ name }: { name: string }) => (
  <Button aria-label={name}>
    <Trash />
  </Button>
);

// Spread on an image → NEVER flag (alt could be in the spread).
export const SpreadImage = (props: Record<string, unknown>) => <Image {...props} />;

// A name-only toggle (TOGGLE_NAMES match, no resolved host, no call-site role) →
// never a finding (externally labelled), and now abstains on the toggle SC
// family so a recall nomination on it is vetoed (G4).
export const BareToggle = () => <Checkbox />;
