import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type EnforceContext,
  enforceContent,
  enforceContentWithAbstentions,
} from "../src/enforce";

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
});

describe("abstention metadata does NOT change emitted findings", () => {
  it("findings from enforceContentWithAbstentions are byte-identical to enforceContent", () => {
    const floor = enforceContent([controls], CTX);
    const { findings } = enforceContentWithAbstentions([controls], CTX);
    expect(findings).toEqual(floor);
  });
});
