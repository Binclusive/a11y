// HARD NEGATIVE (R4): a raw <img> with NO alt attribute — but THIS the static
// FLOOR already catches (jsx-a11y alt-text fires on the missing alt). A
// 1.1.1 nomination here is redundant: R4's content premise
// (`altState === "present"`) is false for a missing alt, so R4 doesn't even
// retrieve the filename pattern; and the SC-disjoint / cross-dedup discipline
// would drop any 1.1.1 recall against the co-located floor finding. The recall
// layer must surface ZERO (the floor owns it).

export const Hero = () => (
  <img src="/hero.jpg" />
);
