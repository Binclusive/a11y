// HARD NEGATIVE (R4): a decorative raw <img> with an explicit empty alt
// (alt=""). Empty alt is the CORRECT decorative pattern — the image is removed
// from the accessibility tree. R4 must NOT treat empty-alt as a finding: the
// content premise (`altState === "present"`) is false for an empty string, so
// 1.1.1-filename-or-generic-alt is never even retrieved. The recall layer must
// surface ZERO.

export const Divider = () => (
  <img src="/divider.svg" alt="" />
);
