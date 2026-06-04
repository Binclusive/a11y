import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { isIconLibrary, isStructural, lookupGuaranteed, lookupRegistry } from "../src/registry";
import { resolveComponents } from "../src/resolve-components";
import { collectLocalImports, resolveRoute, traceComponent } from "../src/source-trace";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "fixtures");
const consumer = join(fixtures, "consumer.tsx");
const myButton = join(fixtures, "my-button.tsx");
const fancyLink = join(fixtures, "forwardref-link.tsx");
const opaqueBuckets = join(fixtures, "opaque-buckets.tsx");
const roleToggleConsumer = join(fixtures, "role-toggle-consumer.tsx");

function sourceFileOf(path: string): ts.SourceFile {
  const text = ts.sys.readFile(path);
  if (text === undefined) throw new Error(`fixture not found: ${path}`);
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

describe("source-trace: synthetic non-@b8e/design wrappers", () => {
  it("infers a host from an arbitrary homegrown wrapper that forwards props", () => {
    // const MyButton = (props) => <button {...props} /> — the canonical case.
    const result = traceComponent("./my-button", "MyButton", consumer);
    expect(result).toEqual({ host: "button", via: "trace", rendersOwnName: false });
  });

  it("unwraps forwardRef(fn) and reads the inner single-host render", () => {
    const result = traceComponent("./forwardref-link", "FancyLink", consumer);
    expect(result).toEqual({ host: "a", via: "trace", rendersOwnName: false });
  });

  it("stays OPAQUE when the wrapper does not forward props", () => {
    // <button>click</button> with no {...props} — we can't claim it's a transparent host.
    expect(traceComponent("./my-button", "NoForwardButton", consumer)).toBeNull();
  });

  it("stays OPAQUE when the wrapper renders more than one distinct host", () => {
    // cond ? <a/> : <button/> — ambiguous, refuse to guess.
    expect(traceComponent("./my-button", "Ambiguous", consumer)).toBeNull();
  });
});

describe("source-trace: carries a toggle role through the trace (#5)", () => {
  it("captures a static role='checkbox' literal from the traced host JSX", () => {
    // const RoleCheckbox = (props) => <button role="checkbox" {...props}/>
    expect(traceComponent("./role-toggle", "RoleCheckbox", consumer)).toEqual({
      host: "button",
      via: "trace",
      role: "checkbox",
      rendersOwnName: false,
    });
    expect(traceComponent("./role-toggle", "RoleSwitch", consumer)).toEqual({
      host: "button",
      via: "trace",
      role: "switch",
      rendersOwnName: false,
    });
  });

  it("carries NO role for a plain button or a dynamic role (uncertain → unchanged)", () => {
    // A static role='button' is not a toggle role; a `role={r}` is unknowable.
    // Either way the trace carries no toggle role — behavior unchanged.
    const plain = traceComponent("./role-toggle", "PlainButton", consumer);
    expect(plain?.host).toBe("button");
    expect(plain?.role).toBeUndefined();
    const dynamic = traceComponent("./role-toggle", "DynamicRole", consumer);
    expect(dynamic?.host).toBe("button");
    expect(dynamic?.role).toBeUndefined();
  });

  it("a Radix Checkbox primitive carries role='checkbox' from the registry", () => {
    // The Epic Stack root cause: Radix renders the checkbox as a <button> but
    // sets role='checkbox' internally — the registry rule carries that role.
    expect(traceComponent("@radix-ui/react-checkbox", "Root", consumer)).toEqual({
      host: "button",
      via: "registry",
      role: "checkbox",
      rendersOwnName: false,
    });
  });

  it("keeps a toggle-role host OUT of the jsx-a11y map (kills the Radix-role FP)", () => {
    const { map, resolutions } = resolveComponents([roleToggleConsumer]);
    const byName = new Map(resolutions.map((r) => [r.name, r]));

    // Both role-carrying toggles resolved to host `button` (counted as covered)…
    expect(byName.get("RoleCheckbox")?.host).toBe("button");
    expect(byName.get("RoleSwitch")?.host).toBe("button");
    expect(
      byName.get("RoleCheckbox")?.provenance !== "opaque" && byName.get("RoleCheckbox")?.role,
    ).toBe("checkbox");
    // …but NOT mapped: jsx-a11y must not treat `<RoleCheckbox aria-invalid>` as a
    // bare <button> and fire role-support rules valid only on role='checkbox'.
    expect(map.RoleCheckbox).toBeUndefined();
    expect(map.RoleSwitch).toBeUndefined();
    // A plain button (no toggle role) is mapped exactly as before.
    expect(map.PlainButton).toBe("button");
  });
});

describe("registry: external library lookup", () => {
  it("maps MUI TextField to input without touching source", () => {
    expect(lookupRegistry("@mui/material", "TextField")).toEqual({
      host: "input",
      library: "MUI",
    });
  });

  it("matches scoped sub-path specifiers by prefix (@mui/material/Button)", () => {
    expect(lookupRegistry("@mui/material/Button", "Button")).toEqual({
      host: "button",
      library: "MUI",
    });
  });

  it("maps MUI v4 (@material-ui/core) exports just like v5", () => {
    // Saleor still imports from the pre-v5 namespace; the host mapping is the same.
    expect(lookupRegistry("@material-ui/core", "TextField")).toEqual({
      host: "input",
      library: "MUI",
    });
    expect(lookupRegistry("@material-ui/core", "Checkbox")).toEqual({
      host: "input",
      library: "MUI",
    });
    expect(lookupRegistry("@material-ui/core/Radio", "Radio")).toEqual({
      host: "input",
      library: "MUI",
    });
  });

  it("returns null for an unknown library", () => {
    expect(lookupRegistry("@some/unknown-lib", "Widget")).toBeNull();
  });

  it("maps antd's unambiguous leaf controls to their host primitives", () => {
    expect(lookupRegistry("antd", "Button")).toEqual({ host: "button", library: "Antd" });
    expect(lookupRegistry("antd", "Input")).toEqual({ host: "input", library: "Antd" });
    expect(lookupRegistry("antd", "InputNumber")).toEqual({ host: "input", library: "Antd" });
    expect(lookupRegistry("antd", "Checkbox")).toEqual({ host: "input", library: "Antd" });
    expect(lookupRegistry("antd", "Radio")).toEqual({ host: "input", library: "Antd" });
    // antd Switch renders a <button role="switch"> (rc-switch), like Radix —
    // the registry carries the toggle role so it isn't read as a bare button.
    expect(lookupRegistry("antd", "Switch")).toEqual({
      host: "button",
      library: "Antd",
      role: "switch",
    });
    expect(lookupRegistry("antd", "Image")).toEqual({ host: "img", library: "Antd" });
  });

  it("leaves antd's ambiguous / compound controls UNmapped (they fall to guaranteed)", () => {
    // Custom-combobox controls render a div, not a native <select>/<input>.
    expect(lookupRegistry("antd", "Select")).toBeNull();
    expect(lookupRegistry("antd", "DatePicker")).toBeNull();
    expect(lookupRegistry("antd", "TimePicker")).toBeNull();
    // Avatar is a <span> unless `src` is set — ambiguous host.
    expect(lookupRegistry("antd", "Avatar")).toBeNull();
    // Compound members collapse to their namespace root in the resolver, so the
    // registry must NOT map the root (it would lend a wrong host to every leaf).
    expect(lookupRegistry("antd", "Typography")).toBeNull();
  });

  it("maps Medusa UI's single-host leaf primitives to their host elements", () => {
    expect(lookupRegistry("@medusajs/ui", "Button")).toEqual({ host: "button", library: "Medusa" });
    expect(lookupRegistry("@medusajs/ui", "IconButton")).toEqual({
      host: "button",
      library: "Medusa",
    });
    expect(lookupRegistry("@medusajs/ui", "Input")).toEqual({ host: "input", library: "Medusa" });
    expect(lookupRegistry("@medusajs/ui", "Textarea")).toEqual({
      host: "textarea",
      library: "Medusa",
    });
    // Checkbox/Switch are Radix primitives -> <button role="checkbox|switch">;
    // the registry carries the toggle role so they aren't read as bare buttons.
    expect(lookupRegistry("@medusajs/ui", "Checkbox")).toEqual({
      host: "button",
      library: "Medusa",
      role: "checkbox",
    });
    expect(lookupRegistry("@medusajs/ui", "Switch")).toEqual({
      host: "button",
      library: "Medusa",
      role: "switch",
    });
  });

  it("leaves Medusa UI's composites / custom combobox UNmapped (they fall to guaranteed)", () => {
    // Select is a Radix-Select custom combobox (button + div popover), NOT a
    // native <select>; RadioGroup is a composite of radios — no single host.
    expect(lookupRegistry("@medusajs/ui", "Select")).toBeNull();
    expect(lookupRegistry("@medusajs/ui", "RadioGroup")).toBeNull();
    // Value / compound components have no single interactive host.
    expect(lookupRegistry("@medusajs/ui", "Table")).toBeNull();
    expect(lookupRegistry("@medusajs/ui", "Badge")).toBeNull();
    expect(lookupRegistry("@medusajs/ui", "Container")).toBeNull();
    expect(lookupRegistry("@medusajs/ui", "Heading")).toBeNull();
    expect(lookupRegistry("@medusajs/ui", "Text")).toBeNull();
    // Label needs call-site context — left out of the registry, like MUI/Chakra.
    expect(lookupRegistry("@medusajs/ui", "Label")).toBeNull();
  });

  it("maps Headless UI's flat leaf controls to their native host elements", () => {
    expect(lookupRegistry("@headlessui/react", "Button")).toEqual({
      host: "button",
      library: "HeadlessUI",
    });
    expect(lookupRegistry("@headlessui/react", "Input")).toEqual({
      host: "input",
      library: "HeadlessUI",
    });
    expect(lookupRegistry("@headlessui/react", "Textarea")).toEqual({
      host: "textarea",
      library: "HeadlessUI",
    });
    // Headless UI Select IS a native <select> wrapper (the div combobox is the
    // separate `Listbox` composite, which stays unmapped below).
    expect(lookupRegistry("@headlessui/react", "Select")).toEqual({
      host: "select",
      library: "HeadlessUI",
    });
    // Switch renders <button> with switch semantics -> carry role="switch".
    expect(lookupRegistry("@headlessui/react", "Switch")).toEqual({
      host: "button",
      library: "HeadlessUI",
      role: "switch",
    });
  });

  it("leaves Headless UI's composites + dot-members UNmapped (they fall to guaranteed)", () => {
    // Every composite is a bundle of elements with no single host.
    for (const composite of [
      "Menu",
      "Listbox",
      "Combobox",
      "Tab",
      "TabGroup",
      "Disclosure",
      "RadioGroup",
      "Dialog",
      "Popover",
      "Transition",
    ]) {
      expect(lookupRegistry("@headlessui/react", composite)).toBeNull();
    }
    // Dot-members collapse to their namespace root in the resolver; the registry
    // must NOT map the root (it would lend a wrong host to every leaf). The flat
    // sub-exports (PopoverPanel, MenuButton) are likewise not single hosts.
    expect(lookupRegistry("@headlessui/react", "PopoverPanel")).toBeNull();
    expect(lookupRegistry("@headlessui/react", "MenuButton")).toBeNull();
  });
});

describe("registry: guaranteed library lookup", () => {
  it("recognizes antd as a guaranteed-accessible design system", () => {
    expect(lookupGuaranteed("antd")).toBe("Antd");
    // Sub-path prefix match resolves too.
    expect(lookupGuaranteed("antd/es/button")).toBe("Antd");
  });

  it("does NOT vouch for the @ant-design scope's non-core packages", () => {
    // The guarantee is pinned to the `antd` package, not the `@ant-design` scope.
    expect(lookupGuaranteed("@ant-design/pro-components")).toBeNull();
    expect(lookupGuaranteed("@ant-design/icons")).toBeNull();
  });

  it("recognizes Medusa UI and Headless UI as guaranteed design systems", () => {
    expect(lookupGuaranteed("@medusajs/ui")).toBe("Medusa");
    expect(lookupGuaranteed("@headlessui/react")).toBe("HeadlessUI");
    // Sub-path prefix matches resolve too.
    expect(lookupGuaranteed("@medusajs/ui/dist/components/button")).toBe("Medusa");
  });

  it("does NOT vouch for the @medusajs scope's non-UI packages", () => {
    // The guarantee is pinned to the `@medusajs/ui` package, not the scope: the
    // scope also carries the icon pack and many non-UI packages.
    expect(lookupGuaranteed("@medusajs/icons")).toBeNull();
    expect(lookupGuaranteed("@medusajs/js-sdk")).toBeNull();
  });
});

describe("registry: icon library recognition", () => {
  it("recognizes the design-system icon packs as icon libraries", () => {
    expect(isIconLibrary("@ant-design/icons")).toBe(true);
    expect(isIconLibrary("@mui/icons-material")).toBe(true);
    expect(isIconLibrary("@chakra-ui/icons")).toBe(true);
    expect(isIconLibrary("@tabler/icons-react")).toBe(true);
    expect(isIconLibrary("@medusajs/icons")).toBe(true);
  });

  it("matches icon-pack sub-paths by prefix", () => {
    expect(isIconLibrary("@ant-design/icons/lib/icons/SearchOutlined")).toBe(true);
    expect(isIconLibrary("@mui/icons-material/Delete")).toBe(true);
  });

  it("does not mistake the antd core package for an icon library", () => {
    expect(isIconLibrary("antd")).toBe(false);
  });

  it("recognizes @medusajs/icons but not the @medusajs/ui primitives", () => {
    expect(isIconLibrary("@medusajs/icons")).toBe(true);
    expect(isIconLibrary("@medusajs/icons/dist/Star")).toBe(true);
    // The UI package is a primitives library, not an icon pack.
    expect(isIconLibrary("@medusajs/ui")).toBe(false);
  });
});

describe("registry: structural plumbing recognition", () => {
  it("recognizes React framework primitives by leaf name (any module)", () => {
    expect(isStructural("Fragment", "react")).toBe(true);
    expect(isStructural("React.Fragment", "react")).toBe(true);
    expect(isStructural("Suspense", "react")).toBe(true);
    expect(isStructural("React.StrictMode", "react")).toBe(true);
    expect(isStructural("Profiler", "react")).toBe(true);
  });

  it("recognizes any *Provider name and the <X.Provider> namespace form", () => {
    expect(isStructural("ThemeProvider", "styled-components")).toBe(true);
    expect(isStructural("QueryClientProvider", "react-query")).toBe(true);
    expect(isStructural("RecordContextProvider", "react-admin")).toBe(true);
    // The `<SidebarContext.Provider>` member form keys on its leaf `Provider`.
    expect(isStructural("SidebarContext.Provider", "./contexts/Sidebar")).toBe(true);
    // A *guaranteed-library* provider is still plumbing, not a primitive.
    expect(isStructural("TooltipPrimitive.Provider", "@radix-ui/react-tooltip")).toBe(true);
  });

  it("recognizes *ErrorBoundary names", () => {
    expect(isStructural("ErrorBoundary", "react-error-boundary")).toBe(true);
    expect(isStructural("GeneralErrorBoundary", "#app/components/error-boundary.tsx")).toBe(true);
  });

  it("recognizes router LAYOUT/document exports — but NEVER the Link/NavLink controls", () => {
    // Structural route-tree + document exports.
    expect(isStructural("Outlet", "react-router")).toBe(true);
    expect(isStructural("Route", "react-router-dom")).toBe(true);
    expect(isStructural("Routes", "react-router-dom")).toBe(true);
    expect(isStructural("Navigate", "react-router")).toBe(true);
    expect(isStructural("Meta", "react-router")).toBe(true);
    expect(isStructural("Scripts", "@remix-run/react")).toBe(true);
    expect(isStructural("Outlet", "@umijs/max")).toBe(true);
    // CONTROLS — these render <a>; a false structural would HIDE a real gap.
    expect(isStructural("Link", "react-router")).toBe(false);
    expect(isStructural("NavLink", "react-router")).toBe(false);
    expect(isStructural("Link", "react-router-dom")).toBe(false);
    expect(isStructural("Link", "@umijs/max")).toBe(false);
  });

  it("recognizes chart and email modules as all-structural (prefix-matched)", () => {
    expect(isStructural("ResponsiveBar", "@nivo/bar")).toBe(true);
    expect(isStructural("Line", "@ant-design/plots")).toBe(true);
    expect(isStructural("LineChart", "recharts")).toBe(true);
    expect(isStructural("E.Html", "@react-email/components")).toBe(true);
  });

  it("is conservative: a router structural NAME from a non-router module is NOT structural", () => {
    // The allowlist is gated to router modules — a same-named app export elsewhere
    // stays in `declare` rather than being silently swallowed.
    expect(isStructural("Outlet", "./components/Outlet")).toBe(false);
    expect(isStructural("Route", "@acme/widgets")).toBe(false);
  });

  it("is conservative: a *Provider/*ErrorBoundary suffix must be a SUFFIX, not a prefix", () => {
    // A container named `ProviderRegistry` / `ErrorBoundaryConfig` is NOT plumbing.
    expect(isStructural("ProviderRegistry", "@acme/widgets")).toBe(false);
    expect(isStructural("ErrorBoundaryConfig", "@acme/widgets")).toBe(false);
  });
});

describe("resolveRoute", () => {
  it("resolves a relative import to its source file", () => {
    expect(resolveRoute("./my-button", consumer)).toBe(myButton);
  });

  it("returns null for an unresolvable bare module", () => {
    // No types/source on disk for this fake package.
    expect(resolveRoute("@some/unknown-lib", consumer)).toBeNull();
  });
});

describe("collectLocalImports", () => {
  it("captures named, aliased, default and namespace imports keyed by local name", () => {
    const imports = collectLocalImports(sourceFileOf(consumer));
    // Named import from an external lib.
    expect(imports.get("TextField")).toEqual({
      module: "@mui/material",
      imported: "TextField",
      isNamespace: false,
    });
    // Named imports from a relative module.
    expect(imports.get("MyButton")).toEqual({
      module: "./my-button",
      imported: "MyButton",
      isNamespace: false,
    });
    expect(imports.get("FancyLink")?.module).toBe("./forwardref-link");
  });

  it("reads the forwardRef fixture's react namespace import", () => {
    const imports = collectLocalImports(sourceFileOf(fancyLink));
    expect(imports.get("React")).toEqual({
      module: "react",
      imported: "*",
      isNamespace: true,
    });
  });
});

describe("resolveComponents: end-to-end coverage over a mixed fixture", () => {
  it("classifies each wrapper by provenance and tallies coverage", () => {
    const { map, coverage, resolutions } = resolveComponents([consumer]);

    // Synthetic wrappers traced from source.
    expect(map.MyButton).toBe("button");
    expect(map.FancyLink).toBe("a");
    // External lib via registry.
    expect(map.TextField).toBe("input");
    // Opaque wrappers are NOT in the map.
    expect(map.NoForwardButton).toBeUndefined();
    expect(map.Ambiguous).toBeUndefined();

    const byName = new Map(resolutions.map((r) => [r.name, r]));
    expect(byName.get("MyButton")?.provenance).toBe("trace");
    expect(byName.get("FancyLink")?.provenance).toBe("trace");
    expect(byName.get("TextField")?.provenance).toBe("registry");
    expect(byName.get("NoForwardButton")?.provenance).toBe("opaque");
    expect(byName.get("Ambiguous")?.provenance).toBe("opaque");

    // 5 wrappers: 1 registry + 2 traced + 2 opaque.
    expect(coverage.total).toBe(5);
    expect(coverage.registry).toBe(1);
    expect(coverage.traced).toBe(2);
    expect(coverage.opaque).toBe(2);
  });
});

describe("resolveComponents: opaque sub-classification (reporting reframe)", () => {
  it("sorts each opaque component into trusted / icons / structural / declare and leaves CHECKED unchanged", () => {
    const { map, coverage, resolutions } = resolveComponents([opaqueBuckets]);
    const byName = new Map(resolutions.map((r) => [r.name, r]));

    // CHECKED — a registry primitive and a traced wrapper land in the map.
    expect(map.TextField).toBe("input");
    expect(map.MyButton).toBe("button");
    expect(byName.get("TextField")?.provenance).toBe("registry");
    expect(byName.get("MyButton")?.provenance).toBe("trace");

    // A Radix opaque → trusted (guaranteed library), NOT in the map.
    const dialog = byName.get("Dialog.Root");
    expect(dialog?.provenance).toBe("opaque");
    expect(dialog?.provenance === "opaque" && dialog.opaqueKind).toBe("trusted");
    expect(dialog?.provenance === "opaque" && dialog.library).toBe("Radix");
    expect(map["Dialog.Root"]).toBeUndefined();
    expect(map.Root).toBeUndefined();

    // A lucide icon → icons (no interactive host), NOT in the map.
    const search = byName.get("Search");
    expect(search?.provenance).toBe("opaque");
    expect(search?.provenance === "opaque" && search.opaqueKind).toBe("icons");
    expect(search?.provenance === "opaque" && search.library).toBeNull();
    expect(map.Search).toBeUndefined();

    // Structural plumbing → structural (no host, no declare hint), NOT in the map.
    // Three shapes: a framework Fragment, a *Provider name, a router layout export.
    for (const name of ["Fragment", "ThemeProvider", "Outlet"]) {
      const r = byName.get(name);
      expect(r?.provenance).toBe("opaque");
      expect(r?.provenance === "opaque" && r.opaqueKind).toBe("structural");
      expect(r?.provenance === "opaque" && r.library).toBeNull();
      expect(map[name]).toBeUndefined();
    }

    // A router CONTROL (<Link> renders <a>) is NOT structural — it stays a
    // genuine `declare` gap. A false structural here would HIDE a real link.
    const link = byName.get("Link");
    expect(link?.provenance).toBe("opaque");
    expect(link?.provenance === "opaque" && link.opaqueKind).toBe("declare");

    // An unknown opaque → declare (the genuine gap), NOT in the map.
    const unknown = byName.get("UnknownWidget");
    expect(unknown?.provenance).toBe("opaque");
    expect(unknown?.provenance === "opaque" && unknown.opaqueKind).toBe("declare");
    expect(unknown?.provenance === "opaque" && unknown.library).toBeNull();
    expect(map.UnknownWidget).toBeUndefined();

    // Tally: 2 checked (1 registry + 1 traced) + 7 opaque
    //   (1 trusted + 1 icons + 3 structural + 2 declare).
    expect(coverage.total).toBe(9);
    expect(coverage.registry).toBe(1);
    expect(coverage.traced).toBe(1);
    expect(coverage.opaque).toBe(7);
    expect(coverage.trusted).toBe(1);
    expect(coverage.icons).toBe(1);
    expect(coverage.structural).toBe(3);
    expect(coverage.declare).toBe(2);
    // The opaque sub-buckets always sum to the opaque total — the reframe never
    // adds or drops a component, only re-labels where each opaque one belongs.
    expect(coverage.trusted + coverage.icons + coverage.structural + coverage.declare).toBe(
      coverage.opaque,
    );
  });

  it("never feeds a trusted/icons/structural/declare component into the jsx-a11y map (checking behavior unchanged)", () => {
    // The map is the only thing jsx-a11y sees; if the reframe leaked an opaque
    // bucket into it, findings would change. Assert the map holds ONLY the
    // CHECKED set, exactly as before the reframe.
    const { map } = resolveComponents([opaqueBuckets]);
    expect(Object.keys(map).sort()).toEqual(["MyButton", "TextField"]);
  });
});
