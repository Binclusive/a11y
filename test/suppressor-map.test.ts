import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { buildSuppressorMap, type SuppressorName } from "../src/suppressor-map";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (name: string): string => join(here, "fixtures", "enforce", name);
const mapFixture = fx("suppressor-map.tsx");

/** Parse a fixture and build its suppressor map, alongside its source lines. */
function mapOf(file: string): {
  readonly map: ReturnType<typeof buildSuppressorMap>;
  readonly lineOf: (needle: string) => number;
} {
  const text = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const lines = text.split("\n");
  const lineOf = (needle: string): number => lines.findIndex((l) => l.includes(needle)) + 1;
  return { map: buildSuppressorMap(sf), lineOf };
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
