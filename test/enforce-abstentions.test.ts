import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  type EnforceContext,
  enforceContent,
  enforceContentWithAbstentions,
} from "../src/enforce";
import type { ComponentResolution } from "../src/resolve-components";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (name: string): string => join(here, "fixtures", "enforce", name);
const controls = fx("controls.tsx");

const CTX: EnforceContext = { resolutions: [], declarations: null, contract: null };

const src = readFileSync(controls, "utf8").split("\n");
const lineOf = (needle: string): number => src.findIndex((l) => l.includes(needle)) + 1;

describe("enforce abstention markers (G4 signal)", () => {
  it("records a 4.1.2 abstention for a spread-props control", () => {
    const { abstentions } = enforceContentWithAbstentions([controls], CTX);
    // SpreadButton: `<Button {...props}>` — content unknowable → abstain.
    const spreadLine = lineOf("<Button {...props}>");
    const hit = abstentions.find((a) => a.line === spreadLine && a.sc === "4.1.2");
    expect(hit).toBeDefined();
    expect(hit?.file).toBe(controls);
  });

  it("records a 4.1.2 abstention for a dynamic-children control", () => {
    const { abstentions } = enforceContentWithAbstentions([controls], CTX);
    // DynamicChildButton: `<Button>{label}</Button>` — child computed → abstain.
    const dynLine = lineOf("export const DynamicChildButton");
    const hit = abstentions.find((a) => a.line === dynLine && a.sc === "4.1.2");
    expect(hit).toBeDefined();
  });

  it("records a 1.1.1 abstention for a spread-props image", () => {
    const { abstentions } = enforceContentWithAbstentions([controls], CTX);
    // SpreadImage: `<Image {...props} />` — alt could be in the spread → abstain.
    const spreadImgLine = lineOf("export const SpreadImage");
    expect(abstentions.some((a) => a.line === spreadImgLine && a.sc === "1.1.1")).toBe(true);
  });

  it("does NOT abstain on a CLEAN (genuinely named) control", () => {
    const { abstentions } = enforceContentWithAbstentions([controls], CTX);
    // ButtonWithText: `<Button>Save</Button>` is named — clean, never an abstention.
    const textLine = lineOf("export const ButtonWithText");
    expect(abstentions.some((a) => a.line === textLine)).toBe(false);
    // IconOnlyLabelled: aria-label present → clean, not an abstention.
    const labelledLine = lineOf("export const IconOnlyLabelled");
    expect(abstentions.some((a) => a.line === labelledLine)).toBe(false);
  });

  it("does NOT abstain on a FLAGGED (clearly nameless) control", () => {
    const { abstentions } = enforceContentWithAbstentions([controls], CTX);
    // IconOnlyTrusted FLAGS — a finding, not an abstention; the two are disjoint.
    const flaggedLine = lineOf("export const IconOnlyTrusted") + 1; // <Button>
    expect(abstentions.some((a) => a.line === flaggedLine)).toBe(false);
  });

  it("abstains on a name-only toggle (TOGGLE_NAMES, no resolved host) — never a finding", () => {
    const { findings, abstentions } = enforceContentWithAbstentions([controls], CTX);
    const toggleLine = lineOf("export const BareToggle"); // <Checkbox /> on the same line
    // The G4 veto now covers a bare `<Checkbox/>`: abstains on the toggle SC family…
    expect(abstentions.some((a) => a.line === toggleLine && a.sc === "4.1.2")).toBe(true);
    expect(abstentions.some((a) => a.line === toggleLine && a.sc === "1.3.1")).toBe(true);
    // …and still emits NO finding (a toggle is externally labelled — floor silent).
    expect(findings.some((f) => f.line === toggleLine)).toBe(false);
  });
});

describe("abstention metadata does NOT change emitted findings", () => {
  it("findings from enforceContentWithAbstentions are byte-identical to enforceContent", () => {
    const floor = enforceContent([controls], CTX);
    const { findings } = enforceContentWithAbstentions([controls], CTX);
    expect(findings).toEqual(floor);
  });
});

describe("shared SourceFile cache does NOT change output (perf refactor)", () => {
  it("a pre-parsed SourceFile yields findings+abstentions identical to read+parse", () => {
    const text = readFileSync(controls, "utf8");
    const sf = ts.createSourceFile(
      controls,
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const fromRead = enforceContentWithAbstentions([controls], CTX);
    const fromCache = enforceContentWithAbstentions(
      [controls],
      CTX,
      new Map([[controls, sf]]),
    );
    expect(fromCache.findings).toEqual(fromRead.findings);
    expect(fromCache.abstentions).toEqual(fromRead.abstentions);
  });

  it("a cache MISS (wrong key) falls back to read+parse — output unchanged", () => {
    const fromRead = enforceContentWithAbstentions([controls], CTX);
    // An unrelated cache entry never matches `controls`, so it read+parses anyway.
    const stray = ts.createSourceFile("other.tsx", "", ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const fromMiss = enforceContentWithAbstentions(
      [controls],
      CTX,
      new Map([["nope.tsx", stray]]),
    );
    expect(fromMiss.findings).toEqual(fromRead.findings);
    expect(fromMiss.abstentions).toEqual(fromRead.abstentions);
  });
});

describe("RESOLVED-HOST skips abstain (findings #2/#8 — G4 inherits enforce)", () => {
  const skips = fx("resolved-host-skips.tsx");
  const skipsSrc = readFileSync(skips, "utf8").split("\n");
  const skipLineOf = (needle: string): number =>
    skipsSrc.findIndex((l) => l.includes(needle)) + 1;

  const RESOLUTIONS: ComponentResolution[] = [
    {
      name: "ConsentBox",
      module: "@/components/ui/consent-box",
      imported: "ConsentBox",
      host: "button",
      provenance: "trace",
      role: "checkbox",
      rendersOwnName: false,
    },
    {
      name: "CarouselPrevious",
      module: "@/components/ui/carousel",
      imported: "CarouselPrevious",
      host: "button",
      provenance: "trace",
      role: null,
      rendersOwnName: true,
    },
  ];
  const SKIP_CTX: EnforceContext = {
    resolutions: RESOLUTIONS,
    declarations: null,
    contract: null,
  };

  it("a traced toggle-role host abstains on its control SC (4.1.2), no finding", () => {
    const { findings, abstentions } = enforceContentWithAbstentions([skips], SKIP_CTX);
    const line = skipLineOf("export const RadixToggle"); // <Checkbox />
    expect(abstentions.some((a) => a.line === line && a.sc === "4.1.2")).toBe(true);
    // The skip emits NO finding — floor output unchanged.
    expect(findings.some((f) => f.line === line)).toBe(false);
  });

  it("a rendersOwnName host abstains on its control SC (4.1.2), no finding", () => {
    const { findings, abstentions } = enforceContentWithAbstentions([skips], SKIP_CTX);
    const line = skipLineOf("export const OwnNameWrapper"); // <CarouselPrevious />
    expect(abstentions.some((a) => a.line === line && a.sc === "4.1.2")).toBe(true);
    expect(findings.some((f) => f.line === line)).toBe(false);
  });

  it("findings stay byte-identical to enforceContent with the skip resolutions", () => {
    const floor = enforceContent([skips], SKIP_CTX);
    const { findings } = enforceContentWithAbstentions([skips], SKIP_CTX);
    expect(findings).toEqual(floor);
  });
});
