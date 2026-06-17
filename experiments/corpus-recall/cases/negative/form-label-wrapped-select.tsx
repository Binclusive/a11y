// HARD NEGATIVE: the SAME design-system Select as the positive, but wrapped in a
// <FormLabel> container — the react-hook-form / MUI convention that pairs a
// label with the control. The floor's label-ancestor suppressor (G3) marks the
// control's line, so a 4.1.2-form-control-no-name / 1.3.1 nomination here is a
// false positive that G3 must veto. Exercises G3 on the label path.

import { FormLabel, Select } from "@mui/material";

export const CountryPicker = () => (
  <FormLabel>
    Country
    <Select value="tr">
      <option value="tr">Turkey</option>
    </Select>
  </FormLabel>
);
