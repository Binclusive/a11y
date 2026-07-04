import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assembleGraph } from "./extract/assemble.js";
import { isTestFile } from "./extract/functions.js";
import { loadCheapProject } from "./extract/project.js";
import { type Smell, type SmellTarget, type Thresholds, ThresholdsSchema } from "./schema.js";

/**
 * selfcheck.test.ts — the self-gate (dogfooding). `@b8e/code-graph` runs its OWN
 * cheap-pass analysis over its `src/` and asserts NO structural smell fires on
 * its non-test code, at the thresholds in `selfcheck.thresholds.json` (defaults,
 * merged the same way the CLI's `--thresholds` does — Parse-Don't-Validate).
 *
 * The tool holds itself to the standard it enforces: the densest functions were
 * refactored to clear the defaults (no relaxed threshold), and this test fails
 * the build if any future change regresses one past the bar.
 *
 * Test files are EXCLUDED: fixtures are intentionally gnarly (e.g. a fixture with
 * complexity 13 that exercises the complexity counter), so a smell whose target
 * lives in a `*.test.ts` / `*.spec.ts` file is not a regression.
 *
 * Cheap pass only (no edges): this covers the STRUCTURAL smells the refactor
 * targeted — long-function, deep-nesting, high-complexity, dense-undocumented,
 * big-file, directory-sprawl. The edge smells (high-fan-in, deep-call-chain) are
 * a separate, opt-in pass and are not part of the self-gate.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = here; // this test lives at the root of src/
const THRESHOLDS_FILE = path.resolve(here, "..", "selfcheck.thresholds.json");

/**
 * Resolve the gate thresholds exactly as the CLI resolves `--thresholds`:
 * defaults from the schema, with the partial overrides in the config file parsed
 * through `ThresholdsSchema.partial()` and merged over them.
 */
function gateThresholds(): Thresholds {
  const defaults = ThresholdsSchema.parse({});
  const raw = JSON.parse(fs.readFileSync(THRESHOLDS_FILE, "utf8"));
  const overrides = ThresholdsSchema.partial().parse(raw);
  return { ...defaults, ...overrides };
}

/** The analyzed-root-relative file a smell points at — `null` for a directory target. */
function targetFile(target: SmellTarget): string | null {
  switch (target.type) {
    case "function":
    case "module":
      return target.file;
    case "directory":
      return null;
    default: {
      const exhaustive: never = target;
      return exhaustive;
    }
  }
}

/** A directory target is never a test file; function/module targets check the path. */
function isTestSmell(smell: Smell): boolean {
  const file = targetFile(smell.target);
  return file !== null && isTestFile(file);
}

/** Human locator for a smell, for the failure message. */
function targetLabel(target: SmellTarget): string {
  switch (target.type) {
    case "function":
      return `${target.id} (${target.file}:${target.startLine})`;
    case "module":
      return target.file;
    case "directory":
      return target.dir;
    default: {
      const exhaustive: never = target;
      return exhaustive;
    }
  }
}

describe("self-gate — @b8e/code-graph passes its own smell checks (dogfooding)", () => {
  it("has zero structural smells on its own non-test src at the gate thresholds", () => {
    const thresholds = gateThresholds();
    const loaded = loadCheapProject(SRC_DIR);
    const graph = assembleGraph(loaded, thresholds);

    const offenders = graph.smells.filter((s) => !isTestSmell(s));

    // The whole value of the gate is naming WHAT regressed — kind + target +
    // value vs threshold — so a dev sees it instantly without re-running the CLI.
    const detail = offenders
      .map(
        (s) =>
          `  ${s.kind}: ${targetLabel(s.target)} — value ${s.value} > threshold ${s.threshold}`,
      )
      .join("\n");

    expect(
      offenders,
      offenders.length === 0
        ? ""
        : `code-graph flags its own non-test code (${offenders.length} smell(s)). ` +
            `Refactor under the gate thresholds, or justify a threshold bump in ` +
            `selfcheck.thresholds.json:\n${detail}`,
    ).toEqual([]);
  });
});
