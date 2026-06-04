// Dedupe fixture: an intrinsic <img> with no alt is flagged by BOTH passes —
// jsx-a11y's `alt-text` (1.1.1) AND the enforce `image-no-alt` (1.1.1). The
// scan must report it ONCE (the jsx-a11y finding), not twice. The enforce twin
// on the SAME line + SAME SC is deduped away.

export const PlainImageNoAlt = () => <img src="/x.png" />;
