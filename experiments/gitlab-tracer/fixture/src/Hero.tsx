// Fixture for the GitLab vertical tracer (#214) — a KNOWN a11y regression the
// engine catches: an <img> with no alt text (jsx-a11y/alt-text, WCAG 1.1.1).
// A human drops this file + the sibling .gitlab-ci.yml into a GitLab project,
// opens an MR, and the pipeline surfaces this finding as an MR note. The
// connected-seam integration test (test/gitlab-tracer.integration.test.ts)
// scans THIS file with the real engine so the same finding drives the note path.
export function Hero() {
  return (
    <section>
      <h1>Welcome</h1>
      <img src="/hero.png" />
    </section>
  );
}
