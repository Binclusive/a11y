// Tracer-test fixture: a bare <img> with no alt attribute. The deterministic
// jsx-a11y pass fires `jsx-a11y/alt-text` (WCAG 1.1.1) on it — the single
// deterministic finding the AI lane runs one pass over in the integration test.
export function Hero() {
  return <img src="/logo.png" />;
}
