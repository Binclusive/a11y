// Exercises the four OPAQUE sub-buckets plus the two CHECKED provenances, so
// resolveComponents' honest reclassification can be asserted end-to-end:
//   - Dialog.Root   — @radix-ui/* composite, no single host on disk → trusted
//   - Search        — lucide-react icon, no interactive host          → icons
//   - Fragment      — React framework plumbing                        → structural
//   - ThemeProvider — *Provider name (a context provider)             → structural
//   - Outlet        — react-router structural layout export           → structural
//   - Link          — react-router CONTROL (<a>), NOT structural      → declare
//   - UnknownWidget — unrecognized library, unresolvable              → declare
//   - MyButton      — homegrown wrapper that forwards props           → checked (trace)
//   - TextField     — MUI registry primitive                          → checked (registry)
import { TextField } from "@mui/material";
import * as Dialog from "@radix-ui/react-dialog";
import { Fragment } from "react";
import { Link, Outlet } from "react-router";
import { ThemeProvider } from "some-theme-lib";
import { Search } from "lucide-react";
import { UnknownWidget } from "@acme/widgets";
import { MyButton } from "./my-button";

export function OpaqueBuckets() {
  return (
    <Fragment>
      <ThemeProvider>
        <Dialog.Root>
          <MyButton type="submit" />
          <TextField label="Name" />
          <Search />
          <Outlet />
          <Link to="/home">Home</Link>
          <UnknownWidget />
        </Dialog.Root>
      </ThemeProvider>
    </Fragment>
  );
}
