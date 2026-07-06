import { describe, expect, it } from "vitest";
import type { Severity } from "@binclusive/a11y-contract";
import {
  GATE_ADVISORY,
  GATE_OFF,
  type GateFinding,
  gateExitCode,
  SEVERITY_ORDER,
} from "../src/severity-gate";

/**
 * The opt-in blocking gate (#2134). The invariant the whole feature rests on is
 * DEFAULT-OFF BY CONSTRUCTION: with no gate set, findings — of any severity or
 * volume — never fail the check on severity alone; only a contract-BLOCKING
 * finding does, exactly as before. Setting `--fail-on` / `--max-violations`
 * opts into a failing exit.
 */

/** A gate finding at `severity`, warn-level (never contract-blocking). */
const warn = (severity: Severity): GateFinding => ({ severity, blocking: false });
/** A gate finding at `severity`, contract-blocking (`enforcement === "block"`). */
const block = (severity: Severity): GateFinding => ({ severity, blocking: true });

describe("SEVERITY_ORDER — sourced from the contract, not hand-rolled", () => {
  it("is the contract's own critical < major < minor ordering", () => {
    expect(SEVERITY_ORDER).toEqual(["critical", "major", "minor"]);
  });
});

describe("gateExitCode — DEFAULT OFF (unset gate ⇒ today's behavior exactly)", () => {
  it("findings present + no gate ⇒ exit 0 (never fails on severity)", () => {
    // A critical + a major warn-level finding, gate unset: still a clean exit.
    const findings = [warn("critical"), warn("major"), warn("minor")];
    expect(gateExitCode(findings, GATE_OFF)).toBe(0);
  });

  it("no gate ⇒ still exits 1 on a contract-BLOCKING finding (preserved default)", () => {
    expect(gateExitCode([block("minor")], GATE_OFF)).toBe(1);
  });

  it("no gate + zero findings ⇒ exit 0", () => {
    expect(gateExitCode([], GATE_OFF)).toBe(0);
  });
});

describe("gateExitCode — OPT-IN --fail-on severity threshold", () => {
  it("at threshold ⇒ non-zero (a critical finding fails fail-on=critical)", () => {
    expect(gateExitCode([warn("critical")], { failOn: "critical", maxViolations: null, advisory: false })).toBe(1);
  });

  it("above threshold ⇒ non-zero (a critical finding fails fail-on=major)", () => {
    expect(gateExitCode([warn("critical")], { failOn: "major", maxViolations: null, advisory: false })).toBe(1);
  });

  it("below threshold ⇒ 0 (a minor finding stays green under fail-on=critical)", () => {
    expect(gateExitCode([warn("minor"), warn("major")], { failOn: "critical", maxViolations: null, advisory: false })).toBe(0);
  });

  it("the SAME findings pass when the gate is unset and fail when opted in", () => {
    const findings = [warn("critical")];
    expect(gateExitCode(findings, GATE_OFF)).toBe(0);
    expect(gateExitCode(findings, { failOn: "critical", maxViolations: null, advisory: false })).toBe(1);
  });

  it("opt-in but no finding reaches the threshold ⇒ 0 even with a blocking warn-below finding", () => {
    // fail-on gates on severity, not on contract-block: a blocking minor does not
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

  it("advisory + any severity/volume of findings ⇒ exit 0 (never fails on its own)", () => {
    const findings = [block("critical"), warn("major"), warn("minor")];
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
    const belowSeverityButOverCount = [warn("minor"), warn("minor")];
    expect(
      gateExitCode(belowSeverityButOverCount, { failOn: "critical", maxViolations: 1, advisory: false }),
    ).toBe(1);
  });
});
