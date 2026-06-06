// App shell — wires the pages together. Uses the @acme/ui Button correctly
// (visible text) so the design system also shows up as zero-false-positive.
import { Button } from "@acme/ui";
import { Nav } from "./components/Nav";
import { Gallery } from "./pages/Gallery";
import { SettingsForm } from "./pages/SettingsForm";

export function App() {
  return (
    <div>
      <Nav />
      <Gallery />
      <SettingsForm />
      {/* CORRECT: labelled design-system button */}
      <Button>Sign out</Button>
    </div>
  );
}
