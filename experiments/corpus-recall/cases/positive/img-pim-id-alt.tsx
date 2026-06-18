// POSITIVE (R4 intrinsic <img>): a raw image whose alt is a PIM/technical id
// ("pim_bu_100093") — a product-catalog identifier announced verbatim instead of
// the image's content. The floor (alt-text) is satisfied; only R4 catches it.
// Pattern: 1.1.1-filename-or-generic-alt (common, eligible).

export const CatalogImage = () => (
  <img src="/catalog/100093.jpg" alt="pim_bu_100093" />
);
