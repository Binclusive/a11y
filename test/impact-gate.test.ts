import { describe, expect, it } from "vitest";
import type { Impact } from "@binclusive/a11y-contract";
import { enforcementFor } from "../src/config-scan";
import type { Contract } from "../src/contract";
import {
  GATE_ADVISORY,
  GATE_OFF,
  type GateFinding,
  gateExitCode,
  IMPACT_ORDER,
} from "../src/impact-gate";

/**
 * The opt-in blocking gate (#2134). The invariant the whole feature rests on is
 * DEFAULT-OFF BY CONSTRUCTION: with no gate set, findings — of any impact or
 * volume — never fail the check on impact alone; only a contract-BLOCKING
 * finding does, exactly as before. Setting `--fail-on` / `--max-violations`
 * opts into a failing exit.
 */

/** A gate finding at `impact`, warn-level (never contract-blocking). */
const warn = (impact: Impact): GateFinding => ({ impact, blocking: false });
/** A gate finding at `impact`, contract-blocking (`enforcement === "block"`). */
const block = (impact: Impact): GateFinding => ({ impact, blocking: true });

describe("IMPACT_ORDER — sourced from the contract, not hand-rolled", () => {
  it("is the contract's own critical < serious < moderate < minor < unknown ordering", () => {
    expect(IMPACT_ORDER).toEqual(["critical", "serious", "moderate", "minor", "unknown"]);
  });
});

describe("gateExitCode — DEFAULT OFF (unset gate ⇒ today's behavior exactly)", () => {
  it("findings present + no gate ⇒ exit 0 (never fails on impact)", () => {
    // A critical + a serious warn-level finding, gate unset: still a clean exit.
    const findings = [warn("critical"), warn("serious"), warn("minor")];
    expect(gateExitCode(findings, GATE_OFF)).toBe(0);
  });

  it("no gate ⇒ still exits 1 on a contract-BLOCKING finding (preserved default)", () => {
    expect(gateExitCode([block("minor")], GATE_OFF)).toBe(1);
  });

  it("no gate + zero findings ⇒ exit 0", () => {
    expect(gateExitCode([], GATE_OFF)).toBe(0);
  });
});

describe("gateExitCode — OPT-IN --fail-on impact threshold", () => {
  it("at threshold ⇒ non-zero (a critical finding fails fail-on=critical)", () => {
    expect(gateExitCode([warn("critical")], { failOn: "critical", maxViolations: null, advisory: false })).toBe(1);
  });

  it("above threshold ⇒ non-zero (a critical finding fails fail-on=serious)", () => {
    expect(gateExitCode([warn("critical")], { failOn: "serious", maxViolations: null, advisory: false })).toBe(1);
  });

  it("below threshold ⇒ 0 (a minor finding stays green under fail-on=critical)", () => {
    expect(gateExitCode([warn("minor"), warn("serious")], { failOn: "critical", maxViolations: null, advisory: false })).toBe(0);
  });

  it("the SAME findings pass when the gate is unset and fail when opted in", () => {
    const findings = [warn("critical")];
    expect(gateExitCode(findings, GATE_OFF)).toBe(0);
    expect(gateExitCode(findings, { failOn: "critical", maxViolations: null, advisory: false })).toBe(1);
  });

  it("opt-in but no finding reaches the threshold ⇒ 0 even with a blocking warn-below finding", () => {
    // fail-on gates on impact, not on contract-block: a blocking minor does not
    // reach fail-on=critical, so the opt-in gate result is 0 (the gate REPLACES
    // the default block-exit when set).
    expect(gateExitCode([block("minor")], { failOn: "critical", maxViolations: null, advisory: false })).toBe(0);
  });
});

describe("gateExitCode — GENERIC CI advisory mode (#2236): non-blocking exit-0 is first-class", () => {
  it("findings present (contract-BLOCKING) + advisory ⇒ exit 0 by default", () => {
    // The core lock: a blocking finding that exits 1 in the plain default exits 0
    // under advisory mode — the engine owns the non-blocking baseline, no shell swallow.
    expect(gateExitCode([block("critical")], GATE_OFF)).toBe(1);
    expect(gateExitCode([block("critical")], GATE_ADVISORY)).toBe(0);
  });

  it("advisory + any impact/volume of findings ⇒ exit 0 (never fails on its own)", () => {
    const findings = [block("critical"), warn("serious"), warn("minor")];
    expect(gateExitCode(findings, GATE_ADVISORY)).toBe(0);
  });

  it("advisory + zero findings ⇒ exit 0", () => {
    expect(gateExitCode([], GATE_ADVISORY)).toBe(0);
  });

  it("advisory is OVERRIDDEN by the opt-in gate — blocking stays available", () => {
    // --fail-on / --max-violations still fail the check in advisory mode, so a CI
    // runner defaulting to non-blocking can opt back into a failing exit.
    expect(gateExitCode([warn("critical")], { failOn: "critical", maxViolations: null, advisory: true })).toBe(1);
    expect(gateExitCode([warn("minor"), warn("minor")], { failOn: null, maxViolations: 1, advisory: true })).toBe(1);
  });

  it("advisory + opt-in gate that does NOT trip ⇒ still 0", () => {
    expect(gateExitCode([warn("minor")], { failOn: "critical", maxViolations: 5, advisory: true })).toBe(0);
  });
});

describe("gateExitCode — OPT-IN --max-violations volume gate", () => {
  it("count exceeds N ⇒ non-zero", () => {
    const findings = [warn("minor"), warn("minor"), warn("minor")];
    expect(gateExitCode(findings, { failOn: null, maxViolations: 2, advisory: false })).toBe(1);
  });

  it("count at/below N ⇒ 0", () => {
    const findings = [warn("minor"), warn("minor")];
    expect(gateExitCode(findings, { failOn: null, maxViolations: 2, advisory: false })).toBe(0);
  });

  it("fail-on and max-violations together ⇒ either tripping fails", () => {
    const belowImpactButOverCount = [warn("minor"), warn("minor")];
    expect(
      gateExitCode(belowImpactButOverCount, { failOn: "critical", maxViolations: 1, advisory: false }),
    ).toBe(1);
  });
});

/**
 * The first-run gating policy (ADR 0010), verified end-to-end over the REAL
 * path: `core`/collectors tag each finding `enforcementFor(wcag, contract)`, and
 * `cli` derives the exit as `gateExitCode(findings.map(toGateFinding), gate)`
 * where `toGateFinding` sets `blocking = enforcement === "block"`. These cases
 * compose those two seams to prove the disposition drives the exit.
 */
describe("first-run gating: no binclusive.json is ADVISORY, not block-all (ADR 0010)", () => {
  // A contract that BLOCKS 1.3.1 only — the configured-opt-in case.
  const blockingContract: Contract = {
    version: 1,
    stack: { framework: "next", router: "app", designSystem: "@acme/ui", language: "ts" },
    enforcement: { block: ["1.3.1"], warn: ["2.4.4"] },
    learned: [],
    declarations: { components: {}, injectsChildren: [], ignore: [] },
  };

  /** Mirror the real path: enforcement disposition → gate's `blocking` flag. */
  const gf = (wcag: readonly string[], contract: Contract | null, impact: Impact = "serious"): GateFinding => ({
    impact,
    blocking: enforcementFor(wcag, contract) === "block",
  });

  it("NO contract + findings ⇒ every finding advisory ⇒ default exit 0 (findings still reported, build not red)", () => {
    // The bug this ADR fixes: with no config every finding used to be `block`, so
    // a first run gated (exit 1) on everything. Now the disposition is advisory.
    const findings = [gf(["1.3.1"], null), gf(["2.4.4"], null), gf(["4.1.2"], null)];
    expect(findings.every((f) => !f.blocking)).toBe(true); // reported, but none blocking
    expect(gateExitCode(findings, GATE_OFF)).toBe(0);
  });

  it("CONFIGURED-block contract ⇒ a blocked SC still blocks ⇒ exit 1 (opt-in blocking unchanged)", () => {
    const findings = [gf(["1.3.1"], blockingContract), gf(["2.4.4"], blockingContract)];
    expect(findings.some((f) => f.blocking)).toBe(true);
    expect(gateExitCode(findings, GATE_OFF)).toBe(1);
  });

  it("NO contract + --fail-on flag ⇒ the gate flag forces blocking on top of the advisory baseline", () => {
    // Advisory-default is the no-config BASELINE, never a cap: an explicit gate
    // flag re-arms a failing exit even though every finding is warn-level.
    const findings = [gf(["2.4.4"], null, "critical")];
    expect(findings.every((f) => !f.blocking)).toBe(true); // advisory disposition…
    expect(gateExitCode(findings, { failOn: "critical", maxViolations: null, advisory: false })).toBe(1); // …but the flag blocks
  });

  it("NO contract + --max-violations flag ⇒ the volume gate forces blocking on the advisory baseline", () => {
    const findings = [gf(["2.4.4"], null), gf(["4.1.2"], null), gf(["1.1.1"], null)];
    expect(gateExitCode(findings, { failOn: null, maxViolations: 2, advisory: false })).toBe(1);
  });
});
