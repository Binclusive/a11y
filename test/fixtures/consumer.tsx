// Consumes the synthetic wrappers + an external-lib (MUI) component + an
// unresolvable import. Exercises collectLocalImports across import shapes and
// gives resolveComponents a realistic mix of provenances.
import { TextField } from "@mui/material";
import { FancyLink } from "./forwardref-link";
import { Ambiguous, MyButton, NoForwardButton } from "./my-button";

export function Consumer() {
  return (
    <div>
      <MyButton type="submit" />
      <NoForwardButton />
      <Ambiguous wide href="/x" />
      <FancyLink href="/y">go</FancyLink>
      <TextField label="Name" />
    </div>
  );
}
