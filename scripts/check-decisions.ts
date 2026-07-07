/**
 * CLI shell for the ADR-sequence collision gate (issue #77, ADR 0008).
 *
 * Runs `lintDecisions` over this repo's `.decisions/` and exits non-zero on any
 * collision or index drift, so the gate is runnable locally (`pnpm
 * decisions:check`) and in CI over the combined post-merge tree. The detection
 * logic lives in `src/decisions-lint.ts`; this file is only the process shell.
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { lintDecisions } from "../src/decisions-lint";

const here = dirname(fileURLToPath(import.meta.url));
const decisionsDir = resolve(here, "..", ".decisions");

const result = lintDecisions(decisionsDir);
if (result.ok) {
  console.log(
    `decisions: OK — ${result.ids.length} ADR(s), no sequence collisions (${result.ids.join(", ")})`,
  );
  process.exit(0);
}

console.error("decisions: COLLISION/DRIFT detected in .decisions/ —");
for (const e of result.errors) console.error(`  - ${e}`);
process.exit(1);
