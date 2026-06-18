// HARD NEGATIVE: an Ant Design Tabs set with no `activeKey`/`aria-selected` in
// the source — yet this is ACCESSIBLE, not a failure. antd `<Tabs>` SELF-MANAGES
// selected state: it auto-selects the first pane and renders `aria-selected` on
// the active tab at runtime. The app pours nothing bad in; the component fixes
// the state itself. A 4.1.2-selected-or-current-state-missing nomination here is
// a FALSE POSITIVE (the static source omits a prop the component supplies), so
// the recall layer must surface ZERO findings.

import { Tabs } from "antd";

export const Panels = () => (
  <Tabs>
    <Tabs.TabPane tab="Profile" key="1" />
    <Tabs.TabPane tab="Security" key="2" />
  </Tabs>
);
