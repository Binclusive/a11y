// POSITIVE (R4 intrinsic <img>): a raw image whose alt is the generic
// PLACEHOLDER "Slider Image 4" — present but meaningless to a screen reader. The
// floor (alt-text) is satisfied; only R4 catches the generic alt.
// Pattern: 1.1.1-filename-or-generic-alt (common, eligible).

export const SlideFour = () => (
  <img src="/slide-4.jpg" alt="Slider Image 4" />
);
