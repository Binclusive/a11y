// A SECOND file for the per-file slice-scoping test. It grounds an image
// pattern (`1.1.1-filename-or-generic-alt`) via an intrinsic <img> that HAS
// alt text (R4 admits the id only on a present-alt img — a missing-alt one is a
// floor case). review.tsx (the other file) has no <img>, so this pattern is in
// THIS file's slice but NOT review.tsx's — exactly the cross-file isolation the
// per-file G1 vocabulary scoping must enforce.
export const Avatar = () => <img src="/avatar.jpg" alt="Photo of Jane Doe" />;
