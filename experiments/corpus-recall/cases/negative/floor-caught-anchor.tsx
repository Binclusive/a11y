// HARD NEGATIVE: a bare intrinsic <a> with no name — but THIS the static FLOOR
// already catches (jsx-a11y anchor-has-content fires on the empty intrinsic
// anchor). A 2.4.4-link-no-name nomination here is redundant: the recall layer
// exists for what the floor MISSES, so dedupeRecall must drop it against the
// co-located same-SC static finding. Exercises the cross-dedup, not a gate.

export const EmptyAnchor = () => <a href="/home" />;
