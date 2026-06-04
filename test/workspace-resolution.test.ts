import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { scan } from "../src/core";
import { resolveComponents } from "../src/resolve-components";
import { resolveRoute, traceComponent } from "../src/source-trace";
import { __resetWorkspaceCachesForTest, resolveWorkspaceImport } from "../src/workspace-resolve";

/**
 * Resolution against a realistic mini-monorepo fixture that mirrors the Rallly
 * shape: a pnpm workspace root, an app under `apps/web/src` whose tsconfig
 * carries a `@/*` path alias and NO explicit `moduleResolution` (the config
 * that used to downgrade us to Classic), and a design-system package under
 * `packages/ui` exporting its source via an `exports` wildcard.
 */

const here = dirname(fileURLToPath(import.meta.url));
const ws = join(here, "fixtures", "workspace-fixture");
const page = join(ws, "apps", "web", "src", "app", "page.tsx");
const labelsPage = join(ws, "apps", "web", "src", "app", "labels.tsx");
const uiButton = join(ws, "packages", "ui", "src", "button.tsx");
const localLink = join(ws, "apps", "web", "src", "components", "local-link.tsx");

afterEach(() => {
  __resetWorkspaceCachesForTest();
});

describe("workspace-package resolution", () => {
  it("follows a workspace `exports` wildcard to the package's real source", () => {
    // `@acme/ui/button` -> packages/ui exports "./*": "./src/*.tsx".
    expect(resolveWorkspaceImport("@acme/ui/button", page)).toBe(uiButton);
  });

  it("resolves the package root via the `.` export", () => {
    expect(resolveWorkspaceImport("@acme/ui", page)).toBe(
      join(ws, "packages", "ui", "src", "index.ts"),
    );
  });

  it("returns null for a package not in the workspace", () => {
    expect(resolveWorkspaceImport("@acme/nope/button", page)).toBeNull();
  });

  it("traces a workspace wrapper through to its forwarded host", () => {
    // Button forwards props to a single <button> — resolvable end to end.
    expect(traceComponent("@acme/ui/button", "Button", page)).toEqual({
      host: "button",
      via: "trace",
      rendersOwnName: false,
    });
  });
});

describe("cross-workspace barrel re-exports", () => {
  it("follows a NAMED re-export barrel to the real single-host definition", () => {
    // `@acme/ui/components/button` -> index.ts `export { BarrelButton } from
    // "./BarrelButton"` -> <button>. The Cal.com barrel shape.
    expect(traceComponent("@acme/ui/components/button", "BarrelButton", page)).toEqual({
      host: "button",
      via: "trace",
      rendersOwnName: false,
    });
  });

  it("follows a STAR re-export (`export * from ...`) to the definition", () => {
    // star-barrel.ts `export * from "../core/star-link"` -> StarLink -> <a>.
    expect(traceComponent("@acme/ui/components/star-barrel", "StarLink", page)).toEqual({
      host: "a",
      via: "trace",
      rendersOwnName: false,
    });
  });

  it("stays OPAQUE when the re-exported name is not actually exported", () => {
    // The barrel re-exports BarrelButton, not Nope — no hop resolves.
    expect(traceComponent("@acme/ui/components/button", "Nope", page)).toBeNull();
  });
});

describe("tsconfig path-alias resolution (no moduleResolution set)", () => {
  it("resolves a `@/*` alias to repo source despite a legacy/absent moduleResolution", () => {
    expect(resolveRoute("@/components/local-link", page)).toBe(localLink);
  });

  it("traces the aliased wrapper to its <a> host", () => {
    expect(traceComponent("@/components/local-link", "LocalLink", page)).toEqual({
      host: "a",
      via: "trace",
      rendersOwnName: false,
    });
  });
});

describe("end-to-end coverage over the workspace fixture", () => {
  it("maps both the workspace and the aliased wrapper to hosts", () => {
    const { map } = resolveComponents([page]);
    expect(map.Button).toBe("button"); // @acme/ui/button (workspace)
    expect(map.LocalLink).toBe("a"); // @/components/local-link (path alias)
    expect(map.Link).toBe("a"); // next/link (registry)
  });
});

describe("label-wrapper exclusion: resolved as coverage, kept out of the map", () => {
  it("counts a self-associating label wrapper as resolved but omits it from the map", () => {
    const { map, resolutions } = resolveComponents([labelsPage]);
    // It resolved to a `label` host (so it's real coverage, not opaque)...
    const formLabel = resolutions.find((r) => r.name === "FormLabel");
    expect(formLabel?.host).toBe("label");
    expect(formLabel?.provenance).not.toBe("opaque");
    // ...but it is NOT in the jsx-a11y map — mapping it would fire
    // label-has-associated-control at every call site (a false positive).
    expect(map.FormLabel).toBeUndefined();
  });

  it("flags the literal <label> but not the self-associating FormLabel", async () => {
    const { findings } = await scan([labelsPage]);
    const labelFindings = findings.filter(
      (f) => f.ruleId === "jsx-a11y/label-has-associated-control",
    );
    // Exactly one: the literal `<label>Name</label>`. FormLabel is excluded.
    expect(labelFindings.length).toBe(1);
  });
});
