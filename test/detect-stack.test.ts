import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { collectTsx } from "../src/collect";
import {
  detectDesignSystem,
  detectFrameworkFromDeps,
  detectStack,
  packageNameOf,
} from "../src/detect-stack";

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
    // usage — the apps/web lesson, pinned as a regression guard.
    expect(stack.designSystem).toBe("@mui/material");
  });

  it("ignores tsconfig path aliases (~/, @/, #) as own code, not a library", () => {
    // The fixture's Card import is `~/components/card` — must never be picked.
    expect(detectDesignSystem([join(fixture, "app", "page.tsx")])).toBe("@mui/material");
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
