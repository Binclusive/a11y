// POSITIVE (R4 intrinsic <a>): a raw anchor whose visible text is a filesystem
// path ("/files/q3-report.pdf") announced verbatim — a polluted accessible name.
// Content present, so the floor stays silent; only R4 catches the noisy name.
// Pattern: 2.4.4-noisy-or-wrong-name (common, eligible).

export const ReportLink = () => (
  <a href="/files/q3-report.pdf">/files/q3-report.pdf</a>
);
