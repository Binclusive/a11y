// POSITIVE (R4 intrinsic <img>): a raw image whose alt is a numbered filename
// ("image123.png") — a present-but-meaningless name. The floor (alt-text) is
// satisfied; only R4 catches the filename-as-alt.
// Pattern: 1.1.1-filename-or-generic-alt (common, eligible).

export const Thumbnail = () => (
  <img src="/thumbs/123.png" alt="image123.png" />
);
