// POSITIVE (R4 intrinsic <img>): a raw image whose alt is a raw camera
// identifier ("DSC_0042") — present but meaningless. The floor (alt-text) is
// satisfied; only R4 catches it.
// Pattern: 1.1.1-filename-or-generic-alt (common, eligible).

export const GalleryShot = () => (
  <img src="/gallery/0042.jpg" alt="DSC_0042" />
);
