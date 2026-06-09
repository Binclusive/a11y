import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectTsx } from "../src/collect";
import {
  detectDesignSystem,
  detectFrameworkFromDeps,
  detectStack,
  packageNameOf,
} from "../src/detect-stack";
import { familyLabel } from "../src/module-scope";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "stack-fixture");
const wsApp = join(here, "fixtures", "workspace-fixture", "apps", "web");
const wsNestedSrc = join(wsApp, "src", "app");

describe("packageNameOf", () => {
  it("collapses per-component sub-paths onto the package", () => {
    expect(packageNameOf("@mui/material/Button")).toBe("@mui/material");
    expect(packageNameOf("next/link")).toBe("next");
    expect(packageNameOf("@radix-ui/react-label")).toBe("@radix-ui/react-label");
    expect(packageNameOf("react")).toBe("react");
  });
});

describe("detectFrameworkFromDeps", () => {
  it("labels React Router v7 framework-mode as react-router, not react", () => {
    // Documenso (RRv7) ships @react-router/node + react-router but NO @remix-run/*.
    const deps = new Set(["react", "react-router", "@react-router/node", "@react-router/dev"]);
    expect(detectFrameworkFromDeps(deps)).toBe("react-router");
  });

  it("keeps a plain SPA using react-router only for routing as react", () => {
    // Bare react-router (no @react-router/node|serve) is client routing, not a
    // meta-framework — must NOT be mislabeled.
    expect(detectFrameworkFromDeps(new Set(["react", "react-router", "react-dom"]))).toBe("react");
  });

  it("prefers Remix over react-router when @remix-run/* is present", () => {
    const deps = new Set(["react", "@remix-run/react", "@remix-run/node"]);
    expect(detectFrameworkFromDeps(deps)).toBe("remix");
  });
});

describe("detectStack: end-to-end on a fixture repo", () => {
  it("detects next + app router + ts, and the dominant component module", async () => {
    const tsx = await collectTsx(fixture);
    const stack = detectStack(fixture, tsx);
    expect(stack.framework).toBe("next");
    expect(stack.router).toBe("app");
    expect(stack.language).toBe("ts");
    // The fixture uses SIX lucide-react icons (opaque, no host) but only TWO
    // MUI wrappers (resolve to button/input). Ranking on resolved-host count
    // means the real design system wins despite the icon library's higher raw
    // usage — the apps/web lesson, pinned as a regression guard. The winning
    // `@mui/material` package is reported by its canonical family label `MUI`.
    expect(stack.designSystem).toBe("MUI");
  });

  it("ignores tsconfig path aliases (~/, @/, #) as own code, not a library", () => {
    // The fixture's Card import is `~/components/card` — must never be picked.
    // @mui/material wins and is reported by its family label `MUI`.
    expect(detectDesignSystem([join(fixture, "app", "page.tsx")])).toBe("MUI");
  });

  it("falls back to custom when no external component library is used", () => {
    expect(detectDesignSystem([])).toBe("custom");
  });
});

describe("detectStack: package-up from a nested dir + framework-primitive exclusion", () => {
  it("detects next/app/ts by walking UP from a nested src/app dir", async () => {
    // Pointed at apps/web/src/app — no package.json or tsconfig there. Detection
    // must climb to apps/web (package.json + tsconfig) rather than degrade to
    // "unknown" / "js" (the original Rallly failure).
    const tsx = await collectTsx(wsNestedSrc);
    const stack = detectStack(wsNestedSrc, tsx);
    expect(stack.framework).toBe("next");
    expect(stack.router).toBe("app");
    expect(stack.language).toBe("ts");
  });

  it("picks the workspace UI package as the design system, not next or react", async () => {
    // The page imports next/link + six lucide icons + one @acme/ui wrapper.
    // next/link is a framework primitive (excluded) and the icons are opaque,
    // so the resolved-host design system is @acme/ui.
    const tsx = await collectTsx(wsNestedSrc);
    expect(detectDesignSystem(tsx)).toBe("@acme/ui");
  });

  it("excludes next/react even when their host-resolving exports dominate usage", () => {
    // Direct check on detectDesignSystem with the fixture page: next/link
    // resolves to <a> via the registry but must never win.
    const page = join(wsNestedSrc, "page.tsx");
    expect(detectDesignSystem([page])).not.toBe("next");
    expect(detectDesignSystem([page])).not.toBe("react");
  });
});

describe("familyLabel: collapse scoped sub-packages to the family name", () => {
  it("collapses every member of a known multi-package family", () => {
    // Radix ships one package per component — each must read as `Radix`.
    expect(familyLabel("@radix-ui/react-checkbox")).toBe("Radix");
    expect(familyLabel("@radix-ui/react-dialog")).toBe("Radix");
    expect(familyLabel("@radix-ui/react-label")).toBe("Radix");
    // The other registered families.
    expect(familyLabel("@mui/material")).toBe("MUI");
    expect(familyLabel("@material-ui/core")).toBe("MUI");
    expect(familyLabel("@chakra-ui/react")).toBe("Chakra UI");
    expect(familyLabel("@headlessui/react")).toBe("Headless UI");
    expect(familyLabel("@mantine/core")).toBe("Mantine");
    expect(familyLabel("@ant-design/pro-components")).toBe("Ant Design");
    expect(familyLabel("antd")).toBe("Ant Design");
    expect(familyLabel("@fluentui/react-components")).toBe("Fluent UI");
  });

  it("passes an unknown / single-package design system through unchanged", () => {
    // A single-package DS or a workspace package is not a family — verbatim.
    expect(familyLabel("bootstrap")).toBe("bootstrap");
    expect(familyLabel("@acme/ui")).toBe("@acme/ui");
    expect(familyLabel("react-aria-components")).toBe("react-aria-components");
    expect(familyLabel("custom")).toBe("custom");
  });

  it("does not collapse a scope that merely shares a prefix string", () => {
    // `@radix-uiX` is a different scope — only `@radix-ui` (exact) or
    // `@radix-ui/...` (sub-path) collapse, never a longer scope name.
    expect(familyLabel("@radix-uikit/core")).toBe("@radix-uikit/core");
  });
});

describe("detectDesignSystem: reports the family name for scoped DS families", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "a11y-ds-family-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reports `Radix`, not the first alphabetical @radix-ui/* sub-package", async () => {
    // A real Radix app imports several per-component packages. The dominant
    // resolved-host package is a sub-package (`@radix-ui/react-checkbox`), which
    // is what `init` used to surface as the design system — the first-impression
    // bug. The reported label must be the family name `Radix`.
    const file = join(dir, "form.tsx");
    await writeFile(
      file,
      [
        'import * as Checkbox from "@radix-ui/react-checkbox";',
        'import * as Switch from "@radix-ui/react-switch";',
        'import * as Label from "@radix-ui/react-label";',
        "export const Form = () => (",
        "  <Label.Root>",
        "    <Checkbox.Root />",
        "    <Switch.Root />",
        "  </Label.Root>",
        ");",
        "",
      ].join("\n"),
    );
    expect(detectDesignSystem([file])).toBe("Radix");
  });

  it("reports `MUI` for the @mui/material package", async () => {
    const file = join(dir, "mui.tsx");
    await writeFile(
      file,
      [
        'import { Button, TextField } from "@mui/material";',
        "export const Mui = () => (",
        "  <>",
        "    <TextField label='Name' />",
        "    <Button>Go</Button>",
        "  </>",
        ");",
        "",
      ].join("\n"),
    );
    expect(detectDesignSystem([file])).toBe("MUI");
  });

  it("leaves a non-family workspace design system unchanged (no collapse)", async () => {
    // `@acme/ui` is a single workspace package, not a known family — it must
    // surface verbatim, exactly as before this change.
    const file = join(dir, "acme.tsx");
    await writeFile(
      file,
      'import { Btn } from "@acme/ui";\nexport const C = () => <Btn>Go</Btn>;\n',
    );
    expect(detectDesignSystem([file])).toBe("@acme/ui");
  });
});
