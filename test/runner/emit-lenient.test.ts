import { describe, expect, it } from "vitest";
import { parseFindingPayload } from "@binclusive/a11y-contract";
import { enrich } from "../../src/corpus";
import type { Finding } from "../../src/core";
import { toFindingPayload, toFindingPayloadLenient } from "../../src/emit-contract";

/**
 * The lenient emit is the AGENT lane's non-blocking boundary — same projection as
 * the strict engine emit, but one malformed finding is DROPPED, never thrown. On
 * well-formed input the two must agree exactly (the lenient path is a superset of
 * the strict one, not a different projection).
 */

const raw = (over: Partial<Finding> = {}): Finding => ({
  file: "src/Button.tsx",
  line: 12,
  ruleId: "jsx-a11y/alt-text",
  message: "img is missing an alt attribute",
  wcag: ["1.1.1"],
  enforcement: "block",
  provenance: "corpus-agent",
  layer: "recall",
  patternId: "p1",
  ...over,
});

describe("toFindingPayloadLenient", () => {
  it("drops nothing and matches the strict projection on well-formed findings", () => {
    const findings = [enrich(raw()), enrich(raw({ ruleId: "jsx-a11y/anchor-is-valid", wcag: ["2.4.4"] }))];
    const { payload, dropped } = toFindingPayloadLenient(findings, "pr-7");
    expect(dropped).toBe(0);
    expect(payload).toEqual(toFindingPayload(findings, "pr-7"));
    expect(() => parseFindingPayload(payload)).not.toThrow();
    expect(payload.findings.every((f) => f.provenance === "agent")).toBe(true);
  });

  it("emits an empty payload for empty input without throwing", () => {
    const { payload, dropped } = toFindingPayloadLenient([], "pr-7");
    expect(dropped).toBe(0);
    expect(payload.findings).toEqual([]);
  });
});
