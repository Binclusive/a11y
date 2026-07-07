// Fixture for the unresolvedPackages signal + its precision rules. The sibling
// package.json declares @totally/not-installed-ui as a dependency; the sibling
// tsconfig declares the `~/*` path alias. Neither resolves on disk.
//
//   - Foo / Bar  from @totally/not-installed-ui  declared dep, not installed → REPORTED
//   - Aliased    from ~/widgets/aliased          path alias, not a dep       → NOT reported
//   - Missing    from ./missing-local            relative, no file on disk   → NOT reported
//   - MyButton   from ../my-button               relative, resolves on disk  → trace (checked)
import { Foo, Bar } from "@totally/not-installed-ui";
import { Aliased } from "~/widgets/aliased";
import { Missing } from "./missing-local";
import { MyButton } from "../my-button";

export function UnresolvedPkgConsumer() {
  return (
    <div>
      <Foo />
      <Bar />
      <Aliased />
      <Missing />
      <MyButton type="submit" />
    </div>
  );
}
