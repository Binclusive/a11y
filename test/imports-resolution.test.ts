import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { __resetImportsCacheForTest, resolveImportsSubpath } from "../src/imports-resolve";
import { resolveComponents } from "../src/resolve-components";
import { resolveRoute, traceComponent } from "../src/source-trace";
import { __resetWorkspaceCachesForTest } from "../src/workspace-resolve";

/**
 * package.json `imports`-subpath resolution → own-code. A `#`-prefixed internal
 * import (`#app/components/app-button`, Epic Stack / modern Remix style) points
 * at the repo's OWN source — the third alias source alongside tsconfig `paths`
 * and workspace packages. TypeScript follows a `#`-import only when it carries an
 * explicit extension; the bare extensionless form falls through to this resolver.
 * These pin: a string `imports` value resolves, a conditional-object value
 * resolves to its RUNTIME target (never `types`), and the resolved wrapper is
 * traced to its host like any own-code component.
 */

const here = dirname(fileURLToPath(import.meta.url));
const importsFixture = join(here, "fixtures", "imports-fixture");
const page = join(importsFixture, "src", "page.tsx");
const appButton = join(importsFixture, "src", "components", "app-button.tsx");
const appLink = join(importsFixture, "lib", "app-link.tsx");

afterEach(() => {
  __resetImportsCacheForTest();
  __resetWorkspaceCachesForTest();
});

describe("resolveImportsSubpath", () => {
  it("resolves a string `imports` subpath (`#app/*` -> `./src/*`), extensionless", () => {
    expect(resolveImportsSubpath("#app/components/app-button", page)).toBe(appButton);
  });

  it("resolves a conditional-object `imports` value to its runtime target, not `types`", () => {
    // `#lib/*` is `{ types, import, default }`; the resolver must pick the
    // runtime target (default/import), never the `.d.ts` `types` target.
    expect(resolveImportsSubpath("#lib/app-link", page)).toBe(appLink);
  });

  it("returns null for a `#`-specifier no pattern covers", () => {
    expect(resolveImportsSubpath("#nope/whatever", page)).toBeNull();
  });

  it("returns null for a non-`#` specifier (not an imports subpath)", () => {
    expect(resolveImportsSubpath("@scope/pkg/button", page)).toBeNull();
  });

  it("answers null when no package.json with `imports` governs the file", () => {
    expect(resolveImportsSubpath("#app/anything", "/nonexistent-root-xyz/file.tsx")).toBeNull();
  });
});

describe("resolveRoute follows `#imports` subpaths as a third own-code source", () => {
  it("resolves an extensionless `#app/...` import TS alone can't reach", () => {
    expect(resolveRoute("#app/components/app-button", page)).toBe(appButton);
  });
});

describe("a `#`-imported own wrapper is traced to its host", () => {
  it("traces the `#app/*` button wrapper to its <button> host", () => {
    expect(traceComponent("#app/components/app-button", "AppButton", page)).toEqual({
      host: "button",
      via: "trace",
      rendersOwnName: false,
    });
  });

  it("traces the conditional `#lib/*` link wrapper to its <a> host", () => {
    expect(traceComponent("#lib/app-link", "AppLink", page)).toEqual({
      host: "a",
      via: "trace",
      rendersOwnName: false,
    });
  });
});

describe("end-to-end: `#imports` wrappers are CHECKED coverage, not declare", () => {
  it("maps both `#`-imported wrappers to hosts (they leave the opaque set)", () => {
    const { map, resolutions } = resolveComponents([page]);
    expect(map.AppButton).toBe("button");
    expect(map.AppLink).toBe("a");
    // Both resolved via trace — neither is opaque/declare.
    const button = resolutions.find((r) => r.name === "AppButton");
    const link = resolutions.find((r) => r.name === "AppLink");
    expect(button?.provenance).toBe("trace");
    expect(link?.provenance).toBe("trace");
  });
});
