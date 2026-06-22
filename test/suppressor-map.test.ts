import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { buildResolvedHosts, type ResolvedHost } from "../src/enforce";
import type { ComponentResolution } from "../src/resolve-components";
import { buildSuppressorMap, type SuppressorName } from "../src/suppressor-map";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (name: string): string => join(here, "fixtures", "enforce", name);
const mapFixture = fx("suppressor-map.tsx");

/** Parse a fixture and build its suppressor map, alongside its source lines. */
function mapOf(
  file: string,
  resolvedHosts: ReadonlyMap<string, ResolvedHost> = new Map(),
): {
  readonly map: ReturnType<typeof buildSuppressorMap>;
  readonly lineOf: (needle: string) => number;
} {
  const text = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const lines = text.split("\n");
  const lineOf = (needle: string): number => lines.findIndex((l) => l.includes(needle)) + 1;
  return { map: buildSuppressorMap(sf, resolvedHosts), lineOf };
}

/** The suppressor names live on `line`, as a plain array (order-insensitive). */
function namesAt(
  map: ReturnType<typeof buildSuppressorMap>,
  line: number,
): readonly SuppressorName[] {
  return [...(map.get(line) ?? new Set<SuppressorName>())];
}

describe("buildSuppressorMap: ancestor suppressors", () => {
  it("a Tooltip-titled IconButton gives name-injecting on the IconButton line", () => {
    const { map, lineOf } = mapOf(mapFixture);
    const iconButtonLine = lineOf("export const TooltipTitledIconButton") + 2; // <IconButton>
    expect(namesAt(map, iconButtonLine)).toContain("name-injecting-wrapper");
  });

  it("a FormLabel-wrapped input gives label-ancestor on the input line", () => {
    const { map, lineOf } = mapOf(mapFixture);
    const inputLine = lineOf('<input type="text" />'); // inside FormLabel
    expect(namesAt(map, inputLine)).toContain("label-ancestor");
  });

  it("does NOT mark the container's OWN line with its ancestor suppressor", () => {
    const { map, lineOf } = mapOf(mapFixture);
    const tooltipLine = lineOf('<Tooltip title="Delete note">');
    const formLabelLine = lineOf("<FormLabel>");
    // The container is not its own ancestor — only its descendants are covered.
    expect(namesAt(map, tooltipLine)).not.toContain("name-injecting-wrapper");
    expect(namesAt(map, formLabelLine)).not.toContain("label-ancestor");
  });
});

describe("buildSuppressorMap: element-local suppressors", () => {
  it("a hidden input gives hidden-untabbable on its line", () => {
    const { map, lineOf } = mapOf(mapFixture);
    const hiddenLine = lineOf('export const HiddenInput = () => <input className="sr-only hidden" />');
    expect(namesAt(map, hiddenLine)).toContain("hidden-untabbable");
  });

  it("a name-exempt input type gives name-exempt-input-type on its line", () => {
    const { map, lineOf } = mapOf(mapFixture);
    const submitLine = lineOf('<input type="submit" value="Send" />');
    expect(namesAt(map, submitLine)).toContain("name-exempt-input-type");
  });

  it("a role=switch control gives toggle-role on its line", () => {
    const { map, lineOf } = mapOf(mapFixture);
    const toggleLine = lineOf('<div role="switch" />');
    expect(namesAt(map, toggleLine)).toContain("toggle-role");
  });
});

describe("buildSuppressorMap: a clean control has no suppressors", () => {
  it("a labelled IconButton under nothing yields an empty set on its line", () => {
    const { map, lineOf } = mapOf(mapFixture);
    const cleanLine = lineOf('<IconButton aria-label="Save">');
    expect(namesAt(map, cleanLine)).toEqual([]);
  });
});

describe("buildSuppressorMap: resolved-host skips (findings #2/#3/#8)", () => {
  const skipsFixture = fx("resolved-host-skips.tsx");

  /** The resolved-host map enforce sees for the resolved-host-skips fixture. */
  const resolved = (): ReadonlyMap<string, ResolvedHost> => {
    const resolutions: ComponentResolution[] = [
      // A homegrown checkbox wrapper → button host carrying role="checkbox" (a
      // toggle reached via trace, not a TOGGLE_NAMES match).
      {
        name: "ConsentBox",
        module: "@/components/ui/consent-box",
        imported: "ConsentBox",
        host: "button",
        provenance: "trace",
        role: "checkbox",
        rendersOwnName: false,
      },
      // A shadcn carousel arrow → button host that renders its own sr-only name.
      {
        name: "CarouselPrevious",
        module: "@/components/ui/carousel",
        imported: "CarouselPrevious",
        host: "button",
        provenance: "trace",
        role: null,
        rendersOwnName: true,
      },
      // A search field wrapper → input host.
      {
        name: "SearchField",
        module: "@/components/ui/search-field",
        imported: "SearchField",
        host: "input",
        provenance: "trace",
        role: null,
        rendersOwnName: false,
      },
      // A plain card → NOT an input host (role/own-name irrelevant).
      {
        name: "Card",
        module: "@/components/ui/card",
        imported: "Card",
        host: "div",
        provenance: "trace",
        role: null,
        rendersOwnName: false,
      },
    ];
    return buildResolvedHosts(resolutions);
  };

  it("a Radix-toggle-resolved control gives toggle-role on its line (G3 veto)", () => {
    const { map, lineOf } = mapOf(skipsFixture, resolved());
    const line = lineOf("export const RadixToggle"); // <Checkbox /> on the same line
    expect(namesAt(map, line)).toContain("toggle-role");
  });

  it("a rendersOwnName-resolved control gives renders-own-name on its line (G3 veto)", () => {
    const { map, lineOf } = mapOf(skipsFixture, resolved());
    const line = lineOf("export const OwnNameWrapper"); // <CarouselPrevious />
    expect(namesAt(map, line)).toContain("renders-own-name");
  });

  it("an input-host wrapper with an exempt type gives name-exempt-input-type", () => {
    const { map, lineOf } = mapOf(skipsFixture, resolved());
    const line = lineOf("export const ExemptInputWrapper"); // <SearchField type="submit" />
    expect(namesAt(map, line)).toContain("name-exempt-input-type");
  });

  it("a NON-input component with a type prop is NOT marked (finding #3 fix)", () => {
    const { map, lineOf } = mapOf(skipsFixture, resolved());
    const line = lineOf("export const NonInputWithType"); // <Card type="submit" />
    expect(namesAt(map, line)).not.toContain("name-exempt-input-type");
  });

  it("with NO resolved hosts, a capitalized component is never name-exempt-marked", () => {
    // The old gate marked every capitalized component (`tag === null`); the
    // correct gate needs a resolved input host, so a bare map marks nothing here.
    const { map, lineOf } = mapOf(skipsFixture);
    expect(namesAt(map, lineOf("export const ExemptInputWrapper"))).not.toContain(
      "name-exempt-input-type",
    );
    expect(namesAt(map, lineOf("export const RadixToggle"))).not.toContain("toggle-role");
  });
});
