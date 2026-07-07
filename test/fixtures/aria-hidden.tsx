// Two empty anchors: one aria-hidden (removed from the a11y tree -> "empty
// link" doesn't apply -> suppressed), one plain (a genuine empty link ->
// MUST still flag). The false-negative guard for the aria-hidden suppression.
export function AriaHidden() {
  return (
    <nav>
      <a href="/decorative" aria-hidden="true" />
      <a href="/real" />
    </nav>
  );
}
