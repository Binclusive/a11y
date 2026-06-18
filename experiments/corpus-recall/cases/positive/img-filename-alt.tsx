// POSITIVE (R4 intrinsic <img>): a raw image whose alt is a CAMERA FILENAME
// ("IMG_4821.jpg"). The alt IS present, so jsx-a11y's alt-text is satisfied and
// the floor stays silent; only the corpus recall layer (R4) catches the
// filename-as-alt. Pattern: 1.1.1-filename-or-generic-alt (common, eligible).

export const ProductPhoto = () => (
  <img src="/p.jpg" alt="IMG_4821.jpg" />
);
