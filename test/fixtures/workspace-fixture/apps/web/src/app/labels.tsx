// Exercises the label-wrapper exclusion: a library FormLabel (self-associating,
// must NOT be in the jsx-a11y map) alongside a genuinely-unassociated literal
// <label> (must still flag label-has-associated-control).
import { FormLabel } from "@acme/ui/form-label";

export function Labels() {
  return (
    <form>
      {/* Library label component — association is internal; no FP expected. */}
      <FormLabel>Email</FormLabel>
      {/* Literal label, no htmlFor, no nested control — a real finding. */}
      <label>Name</label>
    </form>
  );
}
