// POSITIVE: a Chakra-style Tab with no selected/current state exposed. The floor
// has no rule for missing selected-state on a trusted Tab, so only the corpus
// recall layer can flag it. Pattern: 4.1.2-selected-or-current-state-missing
// (common, eligible to flag).

import { Tab } from "@chakra-ui/react";

export const Section = () => <Tab>Overview</Tab>;
