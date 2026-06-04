// Imports the OWN button through the `@app/*` alias AND a real third-party lib
// (MUI, registry-backed). The aliased own button must be excluded from
// design-system ranking, so @mui/material wins despite the alias resolving to a
// host too.
import { Button as MuiButton } from "@mui/material";
import { AppButton } from "@app/components/app-button";

export function Page() {
  return (
    <div>
      <AppButton type="submit" />
      <MuiButton>save</MuiButton>
    </div>
  );
}
