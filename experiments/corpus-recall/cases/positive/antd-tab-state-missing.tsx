// POSITIVE: an Ant Design Tabs set where each TabPane is named but NO active /
// current state is exposed on the rendered item (no `activeKey`/`aria-selected`).
// The items are named, so the floor stays silent; the missing selected state is a
// non-floor SC only the corpus recall layer catches. Pattern:
// 4.1.2-selected-or-current-state-missing (common, eligible to flag).

import { Tabs } from "antd";

export const Panels = () => (
  <Tabs>
    <Tabs.TabPane tab="Profile" key="1" />
    <Tabs.TabPane tab="Security" key="2" />
  </Tabs>
);
