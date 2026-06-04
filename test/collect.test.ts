import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collectTsx } from "../src/collect";

/**
 * `collectTsx` skips test scaffolding — `*.test.tsx` / `*.spec.tsx` /
 * `*.stories.tsx` and anything under `__tests__/`. Those ship in the repo but
 * never render to a real visitor, so an a11y finding in one is noise. Both the
 * scan and stack detection flow through this collector, so the skip is the
 * single chokepoint.
 *
 * The tree is built in a tmp dir at runtime: real `*.test.tsx` files committed
 * under `test/fixtures/` would be collected by vitest itself as (empty) suites.
 */

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "a11y-collect-"));
  const stub = "export const C = () => <div/>;\n";
  writeFileSync(join(root, "component.tsx"), stub);
  writeFileSync(join(root, "component.test.tsx"), stub);
  writeFileSync(join(root, "component.spec.tsx"), stub);
  writeFileSync(join(root, "component.stories.tsx"), stub);
  mkdirSync(join(root, "__tests__"));
  writeFileSync(join(root, "__tests__", "inside.tsx"), stub);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("collectTsx: test files are not shipped UI", () => {
  it("collects production .tsx and skips test/spec/stories + __tests__/", async () => {
    const files = (await collectTsx(root)).map((f) => basename(f));
    expect(files).toContain("component.tsx");
    expect(files).not.toContain("component.test.tsx");
    expect(files).not.toContain("component.spec.tsx");
    expect(files).not.toContain("component.stories.tsx");
    expect(files).not.toContain("inside.tsx"); // under __tests__/
    expect(files.length).toBe(1);
  });
});
