// HARD NEGATIVE (R4): a raw <img> with a clear, descriptive alt. The alt IS
// present AND meaningful — a 1.1.1-filename-or-generic-alt nomination here is a
// false positive on correct code. R4 retrieves the pattern (alt present) but the
// agent must abstain; the recall layer must surface ZERO.

export const RevenueChart = () => (
  <img src="/q3.png" alt="A bar chart showing Q3 revenue up 12%" />
);
