// POSITIVE (R4 intrinsic <a>): a raw anchor whose visible text is a raw,
// query-laden URL announced verbatim — a polluted accessible name. Content
// present, so the floor stays silent; only R4 catches the noisy name.
// Pattern: 2.4.4-noisy-or-wrong-name (common, eligible).

export const Permalink = () => (
  <a href="/p?id=4821">https://shop.example.com/p?id=4821&utm=email</a>
);
