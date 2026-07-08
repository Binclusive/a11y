import { describe, expect, it } from "vitest";
import type { Finding } from "../src/core";
import { enrich, resolveDisplay } from "../src/evidence";
import { formatSarif } from "../src/sarif";

/**
 * #192 regression — a source finding's `fix:`/`ref:` and its SARIF `helpUri` must
 * cite the deque rule matching the finding's OWN rule id, never the first axe rule
 * that happens to share its WCAG SC. The old {@link resolveDisplay} pulled the ref
 * off `baselineBySc`, which returns the alphabetically-first catalog rule for an SC
 * — so `jsx-a11y/alt-text` (SC 1.1.1) showed `aria-meter-name` and
 * `enforce/dialog-no-name` showed `area-alt`, a systematic mis-key across BOTH the
 * human report and the CI-facing SARIF surface.
 */

const src = (over: Partial<Finding> = {}): Finding => ({
  file: "src/Widget.tsx",
  line: 10,
  ruleId: "jsx-a11y/alt-text",
  message: "some message",
  wcag: ["1.1.1"],
  enforcement: "block",
  provenance: "jsx-a11y",
  ...over,
});

// Each source rule → the exact deque doc slug its own rule maps to. The values a
// positional-zip / SC-first regression would get wrong.
const OWN_DEQUE: ReadonlyArray<{ finding: Finding; slug: string; notSlug: string }> = [
  // alt-text's SC-first grab was aria-meter-name; its OWN rule is image-alt.
  { finding: src({ ruleId: "jsx-a11y/alt-text", wcag: ["1.1.1"] }), slug: "image-alt", notSlug: "aria-meter-name" },
  // dialog-no-name's SC-first grab was area-alt; its OWN rule is aria-dialog-name.
  {
    finding: src({ ruleId: "enforce/dialog-no-name", wcag: ["4.1.2", "1.3.1"], provenance: "enforce" }),
    slug: "aria-dialog-name",
    notSlug: "area-alt",
  },
  // input-no-name's SC-first grab was aria-hidden-body; its OWN rule is label.
  {
    finding: src({ ruleId: "enforce/input-no-name", wcag: ["1.3.1", "3.3.2"], provenance: "enforce" }),
    slug: "label",
    notSlug: "aria-hidden-body",
  },
  {
    finding: src({ ruleId: "enforce/link-no-name", wcag: ["2.4.4"], provenance: "enforce" }),
    slug: "link-name",
    notSlug: "area-alt",
  },
  {
    finding: src({ ruleId: "enforce/button-no-name", wcag: ["4.1.2"], provenance: "enforce" }),
    slug: "button-name",
    notSlug: "area-alt",
  },
];

const dequeUrl = (slug: string) => `dequeuniversity.com/rules/axe/4.11/${slug}?`;

describe("#192 resolveDisplay — deque ref matches the finding's own rule, not its SC", () => {
  it.each(OWN_DEQUE)(
    "$finding.ruleId → own deque rule ($slug), never the SC-first ref ($notSlug)",
    ({ finding, slug, notSlug }) => {
      const d = resolveDisplay(enrich(finding));
      // ref: line cites this rule's OWN deque doc...
      expect(d.refUrl).toContain(dequeUrl(slug));
      // ...and never the cross-wired ref the SC-first lookup produced.
      expect(d.refUrl).not.toContain(notSlug);
      // fix: prose is that same own rule's guidance (single-sourced with the ref).
      expect(d.fix).not.toBeNull();
      expect(d.fixLine).toBe(d.fix);
    },
  );

  // The load-bearing positional-zip guard: several findings in a NON-TRIVIAL order,
  // each must resolve to its OWN deque rule. A per-finding pure lookup is invariant
  // under reordering, so shuffling the batch must not change any finding's ref — a
  // regression that re-introduced index/position coupling would fail here.
  it("maps each finding to its own ref independent of position in the batch", () => {
    const findings = OWN_DEQUE.map((c) => enrich(c.finding));
    const refOf = (fs: typeof findings) =>
      new Map(fs.map((f) => [f.ruleId, resolveDisplay(f).refUrl]));

    const inOrder = refOf(findings);
    const reversed = refOf([...findings].reverse());
    const rotated = refOf([...findings.slice(2), ...findings.slice(0, 2)]);

    for (const { finding, slug } of OWN_DEQUE) {
      const expected = dequeUrl(slug);
      expect(inOrder.get(finding.ruleId)).toContain(expected);
      // same rule → same ref, whatever its index in the array.
      expect(reversed.get(finding.ruleId)).toBe(inOrder.get(finding.ruleId));
      expect(rotated.get(finding.ruleId)).toBe(inOrder.get(finding.ruleId));
    }
    // and every finding's ref is distinct — no two collapsed onto one shared rule.
    expect(new Set(inOrder.values()).size).toBe(OWN_DEQUE.length);
  });

  // AC: impact / SC / rule id are untouched — only the fix/ref association moved.
  it("leaves impact, SC and rule id untouched", () => {
    const f = enrich(src({ ruleId: "jsx-a11y/alt-text", wcag: ["1.1.1"] }));
    expect(f.ruleId).toBe("jsx-a11y/alt-text");
    expect(f.wcag).toEqual(["1.1.1"]);
    // impactLabel is still present, derived from enrich — the fix does not drop it.
    expect(resolveDisplay(f).impactLabel).not.toBeNull();
  });
});

describe("#192 SARIF helpUri — same own-rule ref as the text report (both surfaces)", () => {
  it("carries each rule's own deque helpUri, single-sourced with the text ref", () => {
    const findings = OWN_DEQUE.map((c) => enrich(c.finding));
    const sarif = JSON.parse(formatSarif(findings, "pr-192"));
    const rules: Array<{ id: string; helpUri?: string }> = sarif.runs[0].tool.driver.rules;
    const byId = new Map(rules.map((r) => [r.id, r]));

    for (const { finding, slug, notSlug } of OWN_DEQUE) {
      const rule = byId.get(finding.ruleId);
      expect(rule?.helpUri).toContain(dequeUrl(slug));
      expect(rule?.helpUri).not.toContain(notSlug);
      // the SARIF helpUri equals the text report's ref: line — one lookup, two surfaces.
      const textRef = resolveDisplay(enrich(finding)).refUrl;
      expect(rule?.helpUri).toBe(textRef);
    }
  });
});
