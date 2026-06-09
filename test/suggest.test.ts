import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { collectTsx } from "../src/collect";
import type { ComponentResolution } from "../src/resolve-components";
import { resolveComponents } from "../src/resolve-components";
import { type ComponentSuggestion, suggestComponentMap } from "../src/suggest";
import { ownAliasMatcherFor } from "../src/tsconfig-aliases";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "suggest-fixture");

/** A declare-bucket opaque resolution from an external module. */
function declare(name: string, module = "@acme/ui"): ComponentResolution {
  return { name, module, host: null, provenance: "opaque", opaqueKind: "declare", library: null };
}

/** Index suggestions by name for terse assertions. */
function byName(suggestions: readonly ComponentSuggestion[]): Map<string, ComponentSuggestion> {
  return new Map(suggestions.map((s) => [s.name, s]));
}

const noOwnAlias = { isOwnAlias: () => false, designSystem: "@acme/ui" };

describe("suggestComponentMap (pure): leaf-name host guesses", () => {
  it("suggests confident hosts for unambiguous leaf primitives", () => {
    const { suggestions } = suggestComponentMap(
      [
        declare("Button"),
        declare("IconButton"),
        declare("TextField"),
        declare("Link"),
        declare("Avatar"),
      ],
      noOwnAlias,
    );
    const m = byName(suggestions);
    expect(m.get("Button")).toMatchObject({ host: "button", confidence: "confident" });
    expect(m.get("IconButton")).toMatchObject({ host: "button", confidence: "confident" });
    expect(m.get("TextField")).toMatchObject({ host: "input", confidence: "confident" });
    expect(m.get("Link")).toMatchObject({ host: "a", confidence: "confident" });
    expect(m.get("Avatar")).toMatchObject({ host: "img", confidence: "confident" });
  });

  it("flags Select with a ⚠ verify reason (could be a custom widget)", () => {
    const { suggestions } = suggestComponentMap([declare("Select")], noOwnAlias);
    const select = byName(suggestions).get("Select");
    expect(select).toMatchObject({ host: "select", confidence: "verify" });
    expect(select?.reason).toMatch(/custom widget/);
  });

  it("skips composites — no single host — leaving them in declare", () => {
    const composites = ["Modal", "Dialog", "Dropdown", "Menu", "Tabs", "Accordion", "Card"];
    const { suggestions, skipped } = suggestComponentMap(
      composites.map((n) => declare(n)),
      noOwnAlias,
    );
    expect(suggestions).toHaveLength(0);
    for (const c of composites) expect(skipped).toContain(c);
  });

  it("skips a *Provider composite", () => {
    const { suggestions, skipped } = suggestComponentMap([declare("ThemeProvider")], noOwnAlias);
    expect(suggestions).toHaveLength(0);
    expect(skipped).toContain("ThemeProvider");
  });

  it("skips toggles (Checkbox/Switch/Radio/Toggle) — externally labelled", () => {
    const toggles = ["Checkbox", "Switch", "Radio", "Toggle"];
    const { suggestions, skipped } = suggestComponentMap(
      toggles.map((n) => declare(n)),
      noOwnAlias,
    );
    expect(suggestions).toHaveLength(0);
    for (const t of toggles) expect(skipped).toContain(t);
  });

  it("never suggests own-code components (only external libraries)", () => {
    const { suggestions } = suggestComponentMap(
      [
        declare("AppButton", "~/components/app-button"),
        declare("LocalLink", "./local-link"),
        declare("AliasButton", "@/ui/button"),
      ],
      { isOwnAlias: () => false, designSystem: null },
    );
    expect(suggestions).toHaveLength(0);
  });

  it("never suggests framework primitives (next/react)", () => {
    const { suggestions } = suggestComponentMap(
      [{ ...declare("Link", "next/link") }, { ...declare("Image", "next/image") }],
      { isOwnAlias: () => false, designSystem: null },
    );
    expect(suggestions).toHaveLength(0);
  });

  it("only suggests for the declare bucket — never trusted/icons/structural/resolved", () => {
    const resolutions: ComponentResolution[] = [
      {
        name: "MuiButton",
        module: "@mui/material",
        host: "button",
        provenance: "registry",
        role: null,
      },
      {
        name: "RadixDialog",
        module: "@radix-ui/react-dialog",
        host: null,
        provenance: "opaque",
        opaqueKind: "trusted",
        library: "Radix",
      },
      {
        name: "Bell",
        module: "lucide-react",
        host: null,
        provenance: "opaque",
        opaqueKind: "icons",
        library: null,
      },
      {
        name: "Outlet",
        module: "react-router",
        host: null,
        provenance: "opaque",
        opaqueKind: "structural",
        library: null,
      },
      declare("RealUnknownButton"),
    ];
    const { suggestions } = suggestComponentMap(resolutions, noOwnAlias);
    // Only the genuine declare-bucket unknown is suggested.
    expect(suggestions.map((s) => s.name)).toEqual(["RealUnknownButton"]);
  });

  it("dedupes a wrapper used across files into one suggestion", () => {
    const { suggestions } = suggestComponentMap(
      [declare("Button"), declare("Button"), declare("Button")],
      noOwnAlias,
    );
    expect(suggestions.filter((s) => s.name === "Button")).toHaveLength(1);
  });

  it("sorts a collapsed FAMILY label's sub-packages first (Radix label vs @radix-ui/*)", () => {
    // The detected `designSystem` is now the family label `Radix`, while each
    // suggestion's module is a per-component sub-package (`@radix-ui/react-*`).
    // The design-system-first sort must still rank those FIRST — the rank
    // comparison collapses the package through familyLabel, so `Radix` matches.
    const { suggestions } = suggestComponentMap(
      [
        declare("AcmeButton", "@acme/ui"),
        declare("Button", "@radix-ui/react-button"),
        declare("TextField", "@radix-ui/react-text-field"),
      ],
      { isOwnAlias: () => false, designSystem: "Radix" },
    );
    // Both Radix sub-package suggestions lead the list; the non-family @acme/ui
    // suggestion sorts after them.
    expect(suggestions.map((s) => s.name)).toEqual(["Button", "TextField", "AcmeButton"]);
  });
});

describe("suggestComponentMap on the fixture repo (real resolution)", () => {
  it("guesses leaf hosts, flags Select, leaves composites in declare, skips own code", async () => {
    const files = await collectTsx(fixture);
    const { resolutions } = resolveComponents(files);
    const { suggestions, skipped } = suggestComponentMap(resolutions, {
      isOwnAlias: ownAliasMatcherFor(fixture).isOwnAlias,
      designSystem: "@acme/ui",
    });
    const m = byName(suggestions);

    // Leaf primitives → confident hosts.
    expect(m.get("Button")).toMatchObject({ host: "button", confidence: "confident" });
    expect(m.get("IconButton")).toMatchObject({ host: "button", confidence: "confident" });
    expect(m.get("TextField")).toMatchObject({ host: "input", confidence: "confident" });
    expect(m.get("Link")).toMatchObject({ host: "a", confidence: "confident" });
    expect(m.get("Avatar")).toMatchObject({ host: "img", confidence: "confident" });

    // Select is flagged for review.
    expect(m.get("Select")).toMatchObject({ host: "select", confidence: "verify" });

    // Composites stay in declare.
    for (const c of ["Modal", "Dropdown", "Tabs"]) expect(skipped).toContain(c);

    // Toggle skipped; own-code Widget never suggested.
    expect(skipped).toContain("Checkbox");
    expect(m.has("Widget")).toBe(false);
  });
});
