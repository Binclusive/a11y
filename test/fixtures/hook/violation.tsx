// A deliberate jsx-a11y violation, owned by the hook tests so their assertions
// don't ride on shared fixtures: an empty anchor trips anchor-has-content
// (WCAG 2.4.4) — a very-common corpus finding.
export function EmptyLink() {
  return <a href="/dashboard" />;
}
