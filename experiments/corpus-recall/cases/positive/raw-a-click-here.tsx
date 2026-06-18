// POSITIVE (R4 intrinsic <a>): a raw anchor whose visible text is the generic
// "click here". The anchor HAS content, so jsx-a11y's anchor-has-content is
// satisfied and the floor stays silent; only R4 catches the non-descriptive text.
// Pattern: 2.4.4-generic-link-text (common, eligible).

export const HelpLink = () => (
  <a href="/help">click here</a>
);
