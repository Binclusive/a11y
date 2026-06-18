// POSITIVE: a Chakra Tab list where each tab is named but NO selected/current
// state is exposed (no `aria-selected`/`isSelected`). The items are named, so the
// floor stays silent; the missing selected state is a non-floor SC only the
// corpus recall layer catches. Pattern:
// 4.1.2-selected-or-current-state-missing (common, eligible to flag).

import { Tab } from "@chakra-ui/react";

export const Views = () => (
  <div role="tablist">
    <Tab>Day</Tab>
    <Tab>Week</Tab>
  </div>
);
