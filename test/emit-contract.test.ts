import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  Finding as ContractFinding,
  parseFindingPayload,
  Provenance,
  Severity,
} from "@binclusive/a11y-contract";
import { enrich } from "../src/evidence";
import type { Finding, FindingProvenance } from "../src/core";
import {
  contractSeverity,
  impactToSeverity,
  toContractFinding,
  toContractProvenance,
  toFindingPayload,
} from "../src/emit-contract";
import { lineContentHash, type LineSource, resolveLocations } from "../src/source-identity";

/**
 * The wire projection (`localFinding -> contract`) is the "emit the contract"
 * path. These lock its load-bearing guarantees: the output validates against the
 * canonical zod schema, every source locator is dropped at the boundary, and a
 * source finding carries a drift-stable `{ path, lineHash, index }` fingerprint
 * — no `file:line`, no raw content (ADR 0042).
 */

const raw = (over: Partial<Finding> = {}): Finding => ({
  file: "src/Button.tsx",
  line: 12,
  ruleId: "jsx-a11y/alt-text",
  message: "img is missing an alt attribute",
  wcag: ["1.1.1"],
  enforcement: "block",
  provenance: "jsx-a11y",
  ...over,
});

/** A {@link LineSource} that serves `content` at every finding's 1-based `line`. */
const linesWith = (content: string, line: number): LineSource => {
  const lines = Array<string>(line).fill("");
  lines[line - 1] = content;
  return () => lines;
};

/** Resolve one finding's location (single-finding batch → `index` 0 for source). */
function locationOf(f: Finding, lineSource: LineSource) {
  const enriched = enrich(f);
  const location = resolveLocations([enriched], { lineSource, root: "" }).get(enriched);
  if (location === undefined) throw new Error("no location resolved");
  return location;
}

const ALL_PROVENANCE: readonly FindingProvenance[] = [
  "jsx-a11y",
  "enforce",
  "axe",
  "swiftui",
  "liquid",
  "unity",
  "corpus-agent",
];

describe("provenance projection (7-value -> binary)", () => {
  it("maps every deterministic pass to `deterministic` and only corpus-agent to `agent`", () => {
    for (const p of ALL_PROVENANCE) {
      const expected = p === "corpus-agent" ? "agent" : "deterministic";
      expect(toContractProvenance(p)).toBe(expected);
      expect(() => Provenance.parse(toContractProvenance(p))).not.toThrow();
    }
  });
});

describe("severity projection (axe impact -> contract enum)", () => {
  it("collapses the 4-level axe impact onto critical|major|minor", () => {
    expect(impactToSeverity("critical")).toBe("critical");
    expect(impactToSeverity("serious")).toBe("major");
    expect(impactToSeverity("moderate")).toBe("major");
    expect(impactToSeverity("minor")).toBe("minor");
  });

  it("always yields a valid contract severity for any enriched finding", () => {
    const f = enrich(raw({ provenance: "axe", file: "https://x", line: 0, selector: "div", severity: "serious" }));
    expect(() => Severity.parse(contractSeverity(f))).not.toThrow();
  });
});

describe("toContractFinding narrows onto the metadata-only DTO", () => {
  const src = (over: Partial<Finding> = {}) => {
    const f = raw(over);
    return toContractFinding(enrich(f), "changed-files", locationOf(f, linesWith("<img src=x>", 12)));
  };

  it("drops every source locator (file / line / ruleId as keys)", () => {
    const projected = src();
    expect(projected).not.toHaveProperty("file");
    expect(projected).not.toHaveProperty("line");
    expect(projected).not.toHaveProperty("ruleId");
    // A strict re-parse proves no foreign key survived.
    expect(() => ContractFinding.parse(projected)).not.toThrow();
  });

  it("emits a source location — path + lineHash + index, no line number, no content", () => {
    const projected = src();
    expect(projected.location.kind).toBe("source");
    if (projected.location.kind === "source") {
      expect(projected.location.path).toBe("src/Button.tsx");
      expect(projected.location.lineHash).toBe(lineContentHash("<img src=x>"));
      expect(projected.location.index).toBe(0);
      // The moat: the line NUMBER and the raw content are absent from the wire.
      expect(JSON.stringify(projected.location)).not.toContain("12");
      expect(JSON.stringify(projected.location)).not.toContain("<img");
    }
  });

  it("emits a page location (kind:page, url) for a rendered-DOM axe finding", () => {
    const f = raw({ provenance: "axe", file: "https://acme.test/home", line: 0, selector: "a.link" });
    const projected = toContractFinding(enrich(f), "s", locationOf(f, () => undefined));
    expect(projected.location).toEqual({ kind: "page", url: "https://acme.test/home" });
  });

  it("element falls back to the rule id when there is no DOM selector", () => {
    expect(src().element).toBe("jsx-a11y/alt-text");
  });

  it("element falls back to the rule id for an empty or whitespace-only selector", () => {
    for (const selector of ["", "   "]) {
      const f = raw({ provenance: "axe", file: "https://x", line: 0, selector });
      const projected = toContractFinding(enrich(f), "s", locationOf(f, () => undefined));
      expect(projected.element).toBe("jsx-a11y/alt-text");
      expect(projected.element).not.toBe("");
    }
  });

  it("element uses the axe selector when present", () => {
    const f = raw({ provenance: "axe", file: "https://x", line: 0, selector: "main > div.hero" });
    const projected = toContractFinding(enrich(f), "s", locationOf(f, () => undefined));
    expect(projected.element).toBe("main > div.hero");
  });

  it("the deterministic arm carries no agent fields and no legacy `tier`", () => {
    const projected = src();
    expect(projected.provenance).toBe("deterministic");
    expect(projected).not.toHaveProperty("tier");
    expect(projected).not.toHaveProperty("rationale");
  });

  it("the agent arm carries a rationale and no `tier`", () => {
    const f = raw({ provenance: "corpus-agent", layer: "recall", patternId: "p1", enforcement: "warn" });
    const projected = toContractFinding(enrich(f), "s", locationOf(f, linesWith("<x>", 12)));
    expect(projected.provenance).toBe("agent");
    expect(projected).not.toHaveProperty("tier");
    if (projected.provenance === "agent") {
      expect(projected.rationale.length).toBeGreaterThan(0);
    }
  });
});

describe("source identity — lineHash is drift-stable, index is source-position-deterministic", () => {
  it("lineHash is unchanged when unrelated lines are inserted above the finding", () => {
    const content = "  <img src={logo} />"; // leading indent is normalized away
    // Same finding, two scans: the offending content sits at line 12, then at
    // line 40 after unrelated imports were added above it.
    const before = locationOf(raw({ line: 12 }), linesWith(content, 12));
    const after = locationOf(raw({ line: 40 }), linesWith(content, 40));
    if (before.kind !== "source" || after.kind !== "source") throw new Error("expected source");
    expect(after.lineHash).toBe(before.lineHash);
    // And whitespace-only re-formatting of that line does not move the hash.
    const reindented = locationOf(raw({ line: 12 }), linesWith("\t<img  src={logo}  />", 12));
    if (reindented.kind !== "source") throw new Error("expected source");
    expect(reindented.lineHash).toBe(before.lineHash);
  });

  it("index is assigned by source position, not emit order", () => {
    // Two findings with identical line-content in one file, fed to the batch in
    // REVERSE source order (line 30 before line 10). Index must still follow
    // source position: line 10 -> 0, line 30 -> 1, regardless of emit order.
    const dup = "<button/>";
    const lower = enrich(raw({ line: 10 }));
    const upper = enrich(raw({ line: 30 }));
    const lineSource: LineSource = () => {
      const lines = Array<string>(30).fill("");
      lines[9] = dup;
      lines[29] = dup;
      return lines;
    };
    const located = resolveLocations([upper, lower], { lineSource, root: "" });
    const lo = located.get(lower);
    const up = located.get(upper);
    if (lo?.kind !== "source" || up?.kind !== "source") throw new Error("expected source");
    expect(lo.lineHash).toBe(up.lineHash); // identical content -> same hash
    expect(lo.index).toBe(0); // line 10 is first in source
    expect(up.index).toBe(1); // line 30 is second
  });

  it("distinct line-content in one file each get index 0 (no false collision)", () => {
    const a = enrich(raw({ line: 5 }));
    const b = enrich(raw({ line: 9 }));
    const lineSource: LineSource = () => {
      const lines = Array<string>(9).fill("");
      lines[4] = "<a/>";
      lines[8] = "<img/>";
      return lines;
    };
    const located = resolveLocations([a, b], { lineSource, root: "" });
    const la = located.get(a);
    const lb = located.get(b);
    if (la?.kind !== "source" || lb?.kind !== "source") throw new Error("expected source");
    expect(la.index).toBe(0);
    expect(lb.index).toBe(0);
    expect(la.lineHash).not.toBe(lb.lineHash);
  });
});

describe("toFindingPayload — the emit boundary", () => {
  const lineSource: LineSource = () => {
    const lines = Array<string>(12).fill("");
    lines[11] = "<img src={x} />";
    return lines;
  };

  it("produces a payload that validates against the canonical schema", () => {
    const findings = [
      enrich(raw()),
      enrich(raw({ provenance: "axe", file: "https://x", line: 0, selector: "a.link", severity: "critical", wcag: ["1.4.3"] })),
      enrich(raw({ provenance: "corpus-agent", layer: "recall", patternId: "p1", wcag: ["2.4.4"] })),
    ];
    const payload = toFindingPayload(findings, "pr-1291", { lineSource, root: "" });
    // toFindingPayload re-parses internally; a second parse confirms round-trip.
    expect(() => parseFindingPayload(payload)).not.toThrow();
    expect(payload.findings.map((f) => f.provenance)).toEqual(["deterministic", "deterministic", "agent"]);
    expect(payload.findings.every((f) => f.scope === "pr-1291")).toBe(true);
    // The axe finding is page-located; the source ones carry a source fingerprint.
    expect(payload.findings[1].location.kind).toBe("page");
    expect(payload.findings[0].location.kind).toBe("source");
  });

  it("never leaks file/line/content for any provenance", () => {
    fc.assert(
      fc.property(fc.constantFrom(...ALL_PROVENANCE), fc.string(), (provenance, scope) => {
        const payload = toFindingPayload([enrich(raw({ provenance }))], scope, { lineSource, root: "" });
        const [f] = payload.findings;
        expect(f).not.toHaveProperty("file");
        expect(f).not.toHaveProperty("line");
        // No raw source content and no line number survive into the location.
        const loc = JSON.stringify(f.location);
        expect(loc).not.toContain("<img");
        if (f.location.kind === "source") expect(loc).not.toContain('"line"');
      }),
    );
  });
});
