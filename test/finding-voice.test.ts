import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { detailLines } from "../src/cli";
import { enrich } from "../src/corpus";
import type { Finding } from "../src/core";
import { type EnforceContext, enforceContent } from "../src/enforce";
import { impactFirstJsxA11yMessage } from "../src/finding-voice";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (name: string): string => join(here, "fixtures", "enforce", name);
const CTX: EnforceContext = { resolutions: [], declarations: null, contract: null };

/**
 * The impact-first shape (#14): a message names the harmed user and the human
 * consequence — "[who] can't [do what] because [cause], so [fix]". This matcher
 * asserts the load-bearing skeleton: a "can't" clause, a "because" cause, and a
 * trailing ", so " fix clause — present in every authored message.
 */
const IMPACT_FIRST = /can(?:'|’)t .*\bbecause\b.*,\s*so\s+/i;

describe("impact-first jsx-a11y message wrapper (#14)", () => {
  // The exact set core.ts scores (SCORED_RULES) — every one must speak the voice.
  const SCORED = [
    "label-has-associated-control",
    "alt-text",
    "anchor-has-content",
    "anchor-is-valid",
    "aria-props",
    "role-has-required-aria-props",
    "role-supports-aria-props",
    "interactive-supports-focus",
    "click-events-have-key-events",
    "no-static-element-interactions",
    "heading-has-content",
  ];

  it("rewrites every scored jsx-a11y rule into the impact-first shape", () => {
    for (const rule of SCORED) {
      const msg = impactFirstJsxA11yMessage(`jsx-a11y/${rule}`, "UPSTREAM FALLBACK");
      expect(msg, rule).not.toBe("UPSTREAM FALLBACK");
      expect(msg, rule).toMatch(IMPACT_FIRST);
      // The voice leads with the impact, never the rule id or SC number.
      expect(msg, rule).not.toMatch(/^jsx-a11y\//);
    }
  });

  it("falls back to the upstream message for an unmapped rule (never blanks it)", () => {
    const fallback = "Some upstream eslint message we don't remap.";
    expect(impactFirstJsxA11yMessage("jsx-a11y/no-noninteractive-tabindex", fallback)).toBe(
      fallback,
    );
  });

  it("accepts a bare rule name as well as the namespaced id", () => {
    expect(impactFirstJsxA11yMessage("alt-text", "x")).toMatch(IMPACT_FIRST);
    expect(impactFirstJsxA11yMessage("jsx-a11y/alt-text", "x")).toMatch(IMPACT_FIRST);
  });
});

describe("impact-first enforce content messages (#14)", () => {
  it("speaks the impact-first voice and carries no inline (corpus: …) suffix", () => {
    // The controls fixture produces button-no-name findings; assert the message
    // shape on every enforce finding it yields.
    const findings = enforceContent([fx("controls.tsx")], CTX);
    expect(findings.length).toBeGreaterThan(0);
    for (const f of findings) {
      expect(f.message, f.ruleId).toMatch(IMPACT_FIRST);
      // The corpus / SC frequency moved to a secondary line — it is NOT inlined
      // in the impact sentence anymore.
      expect(f.message, f.ruleId).not.toMatch(/\(corpus:/i);
    }
  });
});

describe("detailLines renders the impact message first, identifiers second (#14)", () => {
  it("puts the message line above the rule and wcag lines", () => {
    const finding: Finding = {
      file: "/x.tsx",
      line: 7,
      ruleId: "enforce/button-no-name",
      message:
        "Screen-reader users can't tell what this button does because it has no accessible name, so add visible text or an aria-label.",
      wcag: ["4.1.2"],
      enforcement: "block",
      provenance: "enforce",
    };
    const lines = detailLines(enrich(finding));
    const msgIdx = lines.findIndex((l) => l.includes("Screen-reader users can't"));
    const ruleIdx = lines.findIndex((l) => l.trimStart().startsWith("rule:"));
    const wcagIdx = lines.findIndex((l) => l.trimStart().startsWith("wcag:"));
    expect(msgIdx).toBeGreaterThanOrEqual(0);
    expect(ruleIdx).toBeGreaterThan(msgIdx);
    expect(wcagIdx).toBeGreaterThan(msgIdx);
    // The rule id / WCAG SC are kept as secondary lines, not dropped.
    expect(lines.some((l) => l.includes("enforce/button-no-name"))).toBe(true);
    expect(lines.some((l) => l.includes("WCAG 4.1.2"))).toBe(true);
  });
});
