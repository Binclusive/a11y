import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { detectDesignSystem } from "../src/detect-stack";
import { __resetAliasCacheForTest, ownAliasMatcherFor } from "../src/tsconfig-aliases";

/**
 * tsconfig path-alias → own-code. A project alias that maps INTO the repo's own
 * source (Saleor `@dashboard/* -> src/*`, Cal.com `@coss/ui/* ->
 * packages/.../src/*`) is the team's own components, never a third-party design
 * system. These pin: own-source aliases match, package-re-pointer aliases don't,
 * and an aliased own component never wins the design-system ranking.
 */

const here = dirname(fileURLToPath(import.meta.url));
const aliasFixture = join(here, "fixtures", "alias-fixture");

afterEach(() => {
  __resetAliasCacheForTest();
});

describe("ownAliasMatcherFor", () => {
  it("matches an alias whose target maps into own source (@app/* -> src/*)", () => {
    const m = ownAliasMatcherFor(aliasFixture);
    expect(m.isOwnAlias("@app/components/app-button")).toBe(true);
  });

  it("does NOT match an alias that re-points to an installed package", () => {
    // `@vendor/* -> node_modules/@vendor/*` is an external re-point, not own code.
    const m = ownAliasMatcherFor(aliasFixture);
    expect(m.isOwnAlias("@vendor/widget")).toBe(false);
  });

  it("does NOT match a bare published package the repo simply imports", () => {
    const m = ownAliasMatcherFor(aliasFixture);
    expect(m.isOwnAlias("@mui/material")).toBe(false);
  });

  it("answers false everywhere when no tsconfig governs the dir", () => {
    const m = ownAliasMatcherFor("/nonexistent-root-xyz");
    expect(m.isOwnAlias("@anything/at-all")).toBe(false);
  });
});

describe("detectDesignSystem excludes own-source aliases from ranking", () => {
  it("picks the real third-party lib over the aliased own component", () => {
    const page = join(aliasFixture, "src", "page.tsx");
    // @app/components/app-button traces to <button> but is an own-source alias;
    // @mui/material (registry) is the real design system and must win.
    expect(detectDesignSystem([page], aliasFixture)).toBe("@mui/material");
  });
});
