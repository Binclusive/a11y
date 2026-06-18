// POSITIVE (R4 intrinsic <a>): a raw anchor whose visible text is the generic
// "read more". Content present, so the floor stays silent; only R4 catches the
// non-descriptive text. Pattern: 2.4.4-generic-link-text (common, eligible).

export const ArticleLink = () => (
  <a href="/articles/42">read more</a>
);
