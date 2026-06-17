import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Finding } from "../src/core";
import { type ReviewCandidate, reviewA11y } from "../src/review";

// The deterministic gate stack is driven with SYNTHETIC nominations (no model):
// each candidate is engineered to die at — or clear — exactly one gate, so the
// drop counters and survivor shape pin G0-G6 down mechanically. The fixture's
// static floor produces NO findings (GenericLink is named-but-vague, PlainLink is
// named, TooltipSuppressed is suppressed, SpreadButton abstains), so a survivor is
// never deduped away.

const FIXTURE = resolve(fileURLToPath(new URL("./fixtures/enforce/review.tsx", import.meta.url)));

/**
 * A nomination anchored at the GenericLink survivor by default — a genuine
 * floor-missed failure shape: a link whose text is present ("click here") but
 * non-descriptive, so the AST floor stays silent and recall is the win. (Not a
 * NAMED link: nominating 2.4.4-link-no-name on a visibly-named anchor would read
 * as a contradiction in this executable spec.)
 */
function candidate(over: Partial<ReviewCandidate> = {}): ReviewCandidate {
  return {
    file: FIXTURE,
    line: 50, // `export const GenericLink = () => <Link href="/x">click here</Link>;`
    patternId: "2.4.4-generic-link-text", // common-tier, in this fixture's slice
    codeQuote: "click here",
    wcag: ["2.4.4"],
    confidence: "high",
    message: "Link text is generic and non-descriptive.",
    justification: "The floor can't judge text quality; \"click here\" conveys no destination.",
    ...over,
  };
}

async function verifyOne(c: ReviewCandidate): Promise<readonly Finding[]> {
  const r = await reviewA11y({ verify: true, files: [FIXTURE], candidates: [c] });
  if (r.mode !== "verify") throw new Error("expected verify mode");
  return r.recall;
}

describe("reviewA11y verify — the deterministic G0-G6 gate stack", () => {
  it("G1: drops a candidate whose patternId is NOT in the retrieved slice", async () => {
    // `color-contrast-…` is real WCAG but never a distilled slice pattern here.
    expect(await verifyOne(candidate({ patternId: "color-contrast-not-in-corpus" }))).toEqual([]);
  });

  it("G2: drops a candidate whose codeQuote is not a verbatim substring of the cited line", async () => {
    expect(await verifyOne(candidate({ codeQuote: "THIS TEXT IS NOT ON THE LINE" }))).toEqual([]);
  });

  it("G2: drops a candidate anchored to a line that is not a real JSX element", async () => {
    // Line 5 is an import statement — a real source line, but no JSX element.
    expect(await verifyOne(candidate({ line: 5, codeQuote: "import" }))).toEqual([]);
  });

  it("G3: drops a candidate on a Tooltip-suppressed line (suppressor veto)", async () => {
    // Line 17 is the <IconButton> inside a titled <Tooltip> → name-injecting-wrapper.
    const c = candidate({
      line: 17,
      patternId: "4.1.2-button-no-name",
      codeQuote: "<IconButton>",
      wcag: ["4.1.2"],
    });
    expect(await verifyOne(c)).toEqual([]);
  });

  it("G4: drops a candidate on an abstained line+sc (abstention veto)", async () => {
    // Line 26 is `<Button {...props}>` — the floor ABSTAINS on 4.1.2 (spread).
    const c = candidate({
      line: 26,
      patternId: "4.1.2-button-no-name",
      codeQuote: "<Button",
      wcag: ["4.1.2"],
    });
    expect(await verifyOne(c)).toEqual([]);
  });

  it("G5: drops a low-confidence candidate", async () => {
    expect(await verifyOne(candidate({ confidence: "low" }))).toEqual([]);
    expect(await verifyOne(candidate({ confidence: "medium" }))).toEqual([]);
  });

  it("G6: drops an occasional-tier patternId (context-only, never flags)", async () => {
    // `2.4.4-target-not-signaled` is occasional → in the slice as context (it
    // overlaps the fixture's links), but eligibleToFlag=false, so the tier floor
    // vetoes it.
    const c = candidate({ patternId: "2.4.4-target-not-signaled" });
    expect(await verifyOne(c)).toEqual([]);
  });

  it("G2: surfaces a candidate anchored to a CONTINUATION line of a multi-line JSX opening tag", async () => {
    // The <a> opening tag spans lines 38-40; `href="/multi"` is on line 39, NOT
    // the opening tag's first line. The full opening span must be indexed for G2
    // to accept this anchor (regression: only the first line used to be indexed).
    const recall = await verifyOne(
      candidate({ line: 39, patternId: "2.4.4-link-no-name", codeQuote: 'href="/multi"' }),
    );
    expect(recall).toHaveLength(1);
    expect(recall[0]!.line).toBe(39);
  });

  it("G1: surfaces a candidate whose `file` is a RELATIVE path (facts keyed by resolved path)", async () => {
    // The static-fact maps are keyed by resolved absolute paths. A candidate may
    // carry a relative/non-normalized path; the gate must resolve it the same way
    // or the candidate silently misses every veto map and recall drops to zero.
    const rel = relative(process.cwd(), FIXTURE);
    expect(rel).not.toBe(FIXTURE); // genuinely relative — not already absolute
    const recall = await verifyOne(candidate({ file: rel }));
    expect(recall).toHaveLength(1);
    // The surfaced finding carries the RESOLVED path — not the relative one — so
    // it dedups against the absolute-keyed floor findings instead of escaping the
    // quarantine and duplicating a floor-caught issue.
    expect(recall[0]!.file).toBe(FIXTURE);
  });

  it("SURVIVES: a valid high-confidence common-tier candidate on a real un-suppressed line", async () => {
    const recall = await verifyOne(candidate());
    expect(recall).toHaveLength(1);
    const f = recall[0]!;
    // G8 advisory framing — the survivor's full quarantine shape.
    expect(f.provenance).toBe("corpus-agent");
    expect(f.layer).toBe("recall");
    expect(f.enforcement).toBe("warn");
    expect(f.patternId).toBe("2.4.4-generic-link-text");
    expect(f.line).toBe(50);
    expect(f.file).toBe(FIXTURE);
    expect(f.wcag).toEqual(["2.4.4"]);
  });

  it("reports per-gate drop counts and surfaces only the survivor", async () => {
    const cands: ReviewCandidate[] = [
      candidate(), // survives
      candidate({ patternId: "color-contrast-not-in-corpus" }), // G1
      candidate({ codeQuote: "ABSENT" }), // G2
      candidate({ line: 17, patternId: "4.1.2-button-no-name", codeQuote: "<IconButton>", wcag: ["4.1.2"] }), // G3
      candidate({ line: 26, patternId: "4.1.2-button-no-name", codeQuote: "<Button", wcag: ["4.1.2"] }), // G4
      candidate({ confidence: "low" }), // G5
      candidate({ patternId: "2.4.4-target-not-signaled" }), // G6
    ];
    const r = await reviewA11y({ verify: true, files: [FIXTURE], candidates: cands });
    if (r.mode !== "verify") throw new Error("expected verify mode");
    expect(r.recall).toHaveLength(1);
    expect(r.dropped).toEqual({ G0: 0, G1: 1, G2: 1, G3: 1, G4: 1, G5: 1, G6: 1 });
  });
});

describe("reviewA11y verify — G0 anchor", () => {
  it("drops EVERY candidate when the grounding slice is empty (no grounding)", async () => {
    // A file with no R1/R2/R3 retrieval match → empty slice → G0 vetoes all.
    const empty = resolve(
      fileURLToPath(new URL("./fixtures/enforce/g0-empty.tsx", import.meta.url)),
    );
    const c = candidate({ file: empty, line: 1, patternId: "2.4.4-link-no-name", codeQuote: "x" });
    const r = await reviewA11y({ verify: true, files: [empty], candidates: [c] });
    if (r.mode !== "verify") throw new Error("expected verify mode");
    expect(r.recall).toEqual([]);
    expect(r.dropped.G0).toBe(1);
  });
});

describe("reviewA11y verify — quarantine: recall never gates the build", () => {
  it("survivors are all enforcement=warn (advisory, never block)", async () => {
    const recall = await verifyOne(candidate());
    expect(recall.every((f) => f.enforcement === "warn")).toBe(true);
  });
});

describe("reviewA11y retrieve — the grounding contract", () => {
  it("returns the slice, the static findings, the suppressor facts, and an instruction", async () => {
    const r = await reviewA11y({ files: [FIXTURE] });
    if (r.mode !== "retrieve") throw new Error("expected retrieve mode");
    // The fixture's floor is silent — recall exists for exactly this gap.
    expect(r.staticFindings).toEqual([]);
    // The corpus context is the closed vocabulary the agent may nominate from.
    expect(r.corpusContext.some((p) => p.id === "2.4.4-link-no-name")).toBe(true);
    // Per-line suppressor facts surface the Tooltip-injected name on line 17.
    expect(r.suppressorMap[FIXTURE]?.[17]).toContain("name-injecting-wrapper");
    expect(r.instruction).toMatch(/closed vocabulary|patternId/i);
  });
});
