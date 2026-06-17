/**
 * `review_a11y` — the corpus-grounded RECALL layer (RFC Phase 1, §1e), and the
 * server-side G0-G8 gate stack that disposes of the model's nominations.
 *
 * THE DETERMINISTIC SHELL (ADR 0003): the model PROPOSES, deterministic code
 * DISPOSES. This module is the "disposes" half. It never trusts a model verdict
 * for precision — every survivor has cleared a stack of mechanical gates that run
 * SERVER-SIDE here, reusing the static floor's own hard-won facts (Pass A):
 *
 *   - G3 SUPPRESSOR VETO reuses {@link buildSuppressorMap} — the floor's
 *     suppressor predicates, re-expressed as per-line data.
 *   - G4 ABSTENTION VETO reuses {@link enforceContentWithAbstentions} — the
 *     line+SC the floor CONSIDERED and deliberately declined.
 *
 * Two-step contract (one tool, two modes), so the calling agent (the only place
 * a model runs) sits BETWEEN them:
 *
 *   1. RETRIEVE — `reviewA11y({ files })` runs the static floor, retrieves the
 *      grounding corpus slice ({@link retrieveSlice}), and returns the slice +
 *      the per-line suppressor facts + the static findings + an instruction. The
 *      agent reads this and NOMINATES candidates (closed-vocabulary: only slice
 *      patternIds, only with a verbatim code quote + a line + an adversarial
 *      self-justification — G7, the agent's own step).
 *   2. VERIFY — `reviewA11y({ verify: true, candidates })` runs the candidates
 *      back through the G0-G8 gate stack DETERMINISTICALLY and returns only the
 *      survivors, shaped as advisory recall {@link Finding}s (provenance
 *      `corpus-agent`, layer `recall`, enforcement `warn`).
 *
 * QUARANTINE (RFC 1d): survivors are advisory only. They are deduped against the
 * static floor ({@link dedupeRecall}) and NEVER enter `scan().findings` or the
 * CLI exit code — the caller rides them on the separate `recall` field. The
 * static floor is byte-identical whether or not this layer ever runs.
 */

import { resolve } from "node:path";
import ts from "typescript";
import { collectTsx } from "./collect";
import { type Finding, dedupeRecall, scan } from "./core";
import { type LocatedAbstention, enforceContentWithAbstentions } from "./enforce";
import type { ComponentResolution } from "./resolve-components";
import { type RetrievedPattern, retrieveSlice } from "./retrieve";
import { type SuppressorMap, buildSuppressorMap } from "./suppressor-map";

/**
 * A per-line, per-file static fact bundle the gate stack reads. Recomputed
 * DETERMINISTICALLY from the files in verify mode — the server never trusts a
 * fact the model echoed back, so it re-derives every veto input from source.
 */
interface StaticFacts {
  /** The merged static-floor findings (`scan().findings`) — G-dedup input. */
  readonly findings: readonly Finding[];
  /** The per-component resolutions — R1 input for the grounding slice. */
  readonly resolutions: readonly ComponentResolution[];
  /** Per-file suppressor map (`file -> line -> names`) — G3. */
  readonly suppressors: ReadonlyMap<string, SuppressorMap>;
  /** Per-file abstention keys (`file -> "line:sc"`) — G4. */
  readonly abstentions: ReadonlyMap<string, ReadonlySet<string>>;
  /** Per-file JSX-element line index (`file -> set of opening-tag lines`) — G2. */
  readonly jsxLines: ReadonlyMap<string, ReadonlySet<number>>;
  /** Per-file source text, line-split (1-based access via `[line-1]`) — G2. */
  readonly sourceLines: ReadonlyMap<string, readonly string[]>;
}

/**
 * A per-file, per-line suppressor map plus the JSX-element line index for that
 * file. Built off the SAME `ts.SourceFile` so the line numbering is consistent.
 */
function fileFacts(file: string): {
  readonly suppressors: SuppressorMap;
  readonly jsxLines: ReadonlySet<number>;
  readonly sourceLines: readonly string[];
} | null {
  const text = ts.sys.readFile(file);
  if (text === undefined) return null;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const suppressors = buildSuppressorMap(sf);

  // Every line that opens a real JSX element (intrinsic or component). G2 reads
  // this so a candidate quote on a non-JSX line (a comment, an import) is dropped.
  const jsxLines = new Set<number>();
  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      jsxLines.add(sf.getLineAndCharacterOfPosition(opening.getStart(sf)).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  return { suppressors, jsxLines, sourceLines: text.split("\n") };
}

/** Build the static fact bundle for the gate stack from a set of files. */
async function buildStaticFacts(files: readonly string[]): Promise<StaticFacts> {
  const result = await scan(files);

  // G4 — abstentions, re-derived from the floor's own enforce pass (same input
  // scan used). Keyed `file -> { "line:sc" }`.
  const { abstentions } = enforceContentWithAbstentions([...files].filter((p) => p.endsWith(".tsx")), {
    resolutions: result.resolved.resolutions,
    declarations: result.contract?.declarations ?? null,
    contract: result.contract,
  });
  const abstentionsByFile = indexAbstentions(abstentions);

  const suppressors = new Map<string, SuppressorMap>();
  const jsxLines = new Map<string, ReadonlySet<number>>();
  const sourceLines = new Map<string, readonly string[]>();
  for (const file of files) {
    if (!file.endsWith(".tsx")) continue;
    const facts = fileFacts(file);
    if (facts === null) continue;
    suppressors.set(file, facts.suppressors);
    jsxLines.set(file, facts.jsxLines);
    sourceLines.set(file, facts.sourceLines);
  }

  return {
    findings: result.findings,
    resolutions: result.resolved.resolutions,
    suppressors,
    abstentions: abstentionsByFile,
    jsxLines,
    sourceLines,
  };
}

/** Index abstentions into a `file -> { "line:sc" }` lookup for G4. */
function indexAbstentions(
  abstentions: readonly LocatedAbstention[],
): ReadonlyMap<string, ReadonlySet<string>> {
  const out = new Map<string, Set<string>>();
  for (const a of abstentions) {
    let set = out.get(a.file);
    if (set === undefined) {
      set = new Set<string>();
      out.set(a.file, set);
    }
    set.add(`${a.line}:${a.sc}`);
  }
  return out;
}

/**
 * A model NOMINATION — what the calling agent returns from the retrieve step.
 * The agent picks a patternId FROM the slice, anchors it to a `file:line`, and
 * supplies the `codeQuote` it claims is verbatim at that line plus its
 * adversarial `justification` (G7 — the agent's own self-verify step, carried as
 * a required field so the contract documents it; the deterministic gates do not
 * read it).
 */
export interface ReviewCandidate {
  readonly file: string;
  readonly line: number;
  /** A slice patternId (G1 closed-vocabulary key). */
  readonly patternId: string;
  /** The verbatim source substring the agent claims is at `line` (G2). */
  readonly codeQuote: string;
  /** The WCAG SCs this nomination asserts (carried onto the recall finding). */
  readonly wcag: readonly string[];
  /** The agent's confidence — only `high` clears G5. */
  readonly confidence: "high" | "medium" | "low";
  /** Human-readable advisory message for the surfaced finding. */
  readonly message: string;
  /**
   * G7: the agent's adversarial self-justification ("why is this a real failure
   * the floor missed, and why is the quote not a false positive?"). REQUIRED so
   * the contract forces the agent to argue against itself; the deterministic
   * gates never depend on it (G7 is the calling-agent step, not a server gate).
   */
  readonly justification: string;
}

/**
 * The grounding context the retrieve step hands the agent. The agent reads
 * `corpusContext` (the patterns it MAY flag — closed vocabulary) and
 * `suppressorMap` (the per-line do-not-flag facts, so it self-suppresses before
 * the server even has to veto) and returns {@link ReviewCandidate}s.
 */
export interface ReviewRetrieveResult {
  readonly mode: "retrieve";
  /** The deterministic static-floor findings — the recall layer dedups against these. */
  readonly staticFindings: readonly Finding[];
  /** The corpus slice — the ONLY patterns the agent may nominate (G1 vocabulary). */
  readonly corpusContext: readonly RetrievedPattern[];
  /** Per-file do-not-flag facts: `file -> line -> suppressor names`. */
  readonly suppressorMap: Readonly<Record<string, Readonly<Record<number, readonly string[]>>>>;
  /** The contract the agent follows when nominating. */
  readonly instruction: string;
}

/** The verify step's result: the surviving advisory recall findings. */
export interface ReviewVerifyResult {
  readonly mode: "verify";
  /** Survivors of the G0-G8 gate stack — advisory `corpus-agent` / `recall` findings. */
  readonly recall: readonly Finding[];
  /** Per-gate drop counts, for observability (no candidate identities leak). */
  readonly dropped: Readonly<Record<GateId, number>>;
}

/** The two-step input: retrieve (default) or verify. */
export type ReviewInput =
  | { readonly files: readonly string[]; readonly verify?: false }
  | {
      readonly verify: true;
      readonly files: readonly string[];
      readonly candidates: readonly ReviewCandidate[];
    };

/** The gates a candidate can die at, in stack order. G7 is the agent's step. */
export type GateId = "G0" | "G1" | "G2" | "G3" | "G4" | "G5" | "G6";

/** Only `high`-confidence nominations clear G5. */
const G5_CONFIDENCE = "high";

const INSTRUCTION = [
  "You are the PROPOSE half of a deterministic-shell recall pass.",
  "Nominate accessibility failures the static floor MISSED, grounded ONLY in corpusContext.",
  "Rules you MUST follow (the server re-checks every one and silently drops violations):",
  "1. Use ONLY a patternId present in corpusContext (closed vocabulary).",
  "2. Only patterns with eligibleToFlag=true may be flagged; the rest are context only.",
  "3. codeQuote MUST be a verbatim substring of the cited line, and the line must be a real JSX element.",
  "4. Do NOT flag a line carrying a suppressor in suppressorMap.",
  "5. Set confidence=high only when you are certain; medium/low are dropped.",
  "6. For each candidate, write a justification that argues AGAINST yourself (G7 self-verify): why is this real, why is it not a false positive, why did the floor miss it?",
  "Then call review_a11y again with { verify: true, files, candidates } to get the surviving findings.",
].join("\n");

/**
 * The retrieve step. Runs the static floor, retrieves the grounding slice, and
 * hands the agent everything it needs to nominate — but nothing that lets it
 * flag outside the closed vocabulary. Pure read; emits no findings.
 */
async function retrieve(files: readonly string[]): Promise<ReviewRetrieveResult> {
  const result = await scan(files);
  const tsx = [...files].filter((p) => p.endsWith(".tsx"));
  const slice = retrieveSlice({
    files: tsx,
    resolutions: result.resolved.resolutions,
    findings: result.findings,
  });

  // Per-file suppressor facts, serialized for the wire (Map/Set -> plain object).
  const suppressorMap: Record<string, Record<number, readonly string[]>> = {};
  for (const file of tsx) {
    const facts = fileFacts(file);
    if (facts === null) continue;
    const perLine: Record<number, readonly string[]> = {};
    for (const [line, names] of facts.suppressors) perLine[line] = [...names];
    if (Object.keys(perLine).length > 0) suppressorMap[file] = perLine;
  }

  return {
    mode: "retrieve",
    staticFindings: result.findings,
    corpusContext: slice.patterns,
    suppressorMap,
    instruction: INSTRUCTION,
  };
}

/**
 * The G0-G8 gate stack, run DETERMINISTICALLY over the model nominations. Each
 * gate is a hard veto; a candidate must clear ALL of them to survive. The order
 * is the cheapest-first / most-fundamental-first stack from the RFC.
 *
 *   - G0 ANCHOR — an empty slice means no grounding; nothing may flag.
 *   - G1 CLOSED-VOCABULARY — drop unless the patternId is in the slice.
 *   - G2 MECHANICAL — drop unless `codeQuote` is a verbatim substring AT the
 *     cited line AND the line is a real JSX element.
 *   - G3 SUPPRESSOR VETO — drop if the floor's suppressor map marks that line
 *     (reuses {@link buildSuppressorMap}).
 *   - G4 ABSTENTION VETO — drop if the floor recorded an abstention at that
 *     line+sc (reuses {@link enforceContentWithAbstentions}).
 *   - G5 CONFIDENCE FLOOR — drop unless `confidence === "high"`.
 *   - G6 TIER FLOOR — drop unless the slice pattern is eligible to flag
 *     (very-common / common; `occasional` is context-only and never flags).
 *   - G8 ADVISORY FRAMING — survivors are shaped as `corpus-agent` / `recall` /
 *     `warn` findings carrying the patternId (done in {@link toRecallFinding}).
 */
function gate(
  candidates: readonly ReviewCandidate[],
  slice: readonly RetrievedPattern[],
  facts: StaticFacts,
): { readonly survivors: Finding[]; readonly dropped: Record<GateId, number> } {
  const dropped: Record<GateId, number> = { G0: 0, G1: 0, G2: 0, G3: 0, G4: 0, G5: 0, G6: 0 };
  const byId = new Map(slice.map((p) => [p.id, p]));

  // G0 ANCHOR — empty slice ⇒ no grounding ⇒ every candidate dies here.
  if (slice.length === 0) {
    dropped.G0 = candidates.length;
    return { survivors: [], dropped };
  }

  const survivors: Finding[] = [];
  for (const c of candidates) {
    // G1 — closed vocabulary: the patternId must be a slice pattern.
    const pattern = byId.get(c.patternId);
    if (pattern === undefined) {
      dropped.G1++;
      continue;
    }

    // G2 — mechanical: the cited line must be a real JSX element AND the quote
    // must be a verbatim substring of that exact line.
    const lines = facts.sourceLines.get(c.file);
    const jsx = facts.jsxLines.get(c.file);
    const srcLine = lines?.[c.line - 1];
    if (
      srcLine === undefined ||
      jsx === undefined ||
      !jsx.has(c.line) ||
      c.codeQuote === "" ||
      !srcLine.includes(c.codeQuote)
    ) {
      dropped.G2++;
      continue;
    }

    // G3 — suppressor veto: a floor suppressor on this line vetoes the finding.
    const suppressors = facts.suppressors.get(c.file)?.get(c.line);
    if (suppressors !== undefined && suppressors.size > 0) {
      dropped.G3++;
      continue;
    }

    // G4 — abstention veto: the floor CONSIDERED this line+sc and declined.
    const abstained = facts.abstentions.get(c.file);
    if (abstained !== undefined && c.wcag.some((sc) => abstained.has(`${c.line}:${sc}`))) {
      dropped.G4++;
      continue;
    }

    // G5 — confidence floor: only `high` survives.
    if (c.confidence !== G5_CONFIDENCE) {
      dropped.G5++;
      continue;
    }

    // G6 — tier floor: `occasional` patterns are context-only (eligibleToFlag
    // false); only very-common / common may surface a finding.
    if (!pattern.eligibleToFlag) {
      dropped.G6++;
      continue;
    }

    // G8 — advisory framing: shape the survivor as a quarantined recall finding.
    survivors.push(toRecallFinding(c));
  }

  return { survivors, dropped };
}

/**
 * G8 advisory framing: shape a surviving candidate into the recall {@link Finding}.
 * provenance `corpus-agent`, layer `recall`, enforcement `warn`, carrying the
 * `patternId` — the same shape `dedupeRecall` and the `scan().recall` quarantine
 * field expect. Advisory by construction: `warn` can never gate the exit code.
 */
function toRecallFinding(c: ReviewCandidate): Finding {
  return {
    file: c.file,
    line: c.line,
    ruleId: `corpus/${c.patternId}`,
    message: c.message,
    wcag: c.wcag,
    enforcement: "warn",
    provenance: "corpus-agent",
    layer: "recall",
    patternId: c.patternId,
  };
}

/**
 * The verify step. Recompute the static facts deterministically (the server
 * NEVER trusts a fact the model echoed back), run the gate stack, dedup the
 * survivors against the static floor ({@link dedupeRecall}), and return the
 * advisory recall findings. Quarantined: these are never mixed into the floor.
 */
async function verify(
  files: readonly string[],
  candidates: readonly ReviewCandidate[],
): Promise<ReviewVerifyResult> {
  const facts = await buildStaticFacts(files);
  const tsx = [...files].filter((p) => p.endsWith(".tsx"));
  const slice = retrieveSlice({
    files: tsx,
    resolutions: facts.resolutions,
    findings: facts.findings,
  });

  const { survivors, dropped } = gate(candidates, slice.patterns, facts);
  // Dedup against the static floor (and self) — the floor already caught some,
  // and the recall layer exists for what it MISSED.
  const recall = dedupeRecall(survivors, facts.findings);
  return { mode: "verify", recall, dropped };
}

/**
 * `review_a11y`: the two-step recall tool. With `{ files }` it RETRIEVES (the
 * grounding context the agent nominates from); with `{ verify: true, candidates }`
 * it VERIFIES (the server-side gate stack disposes of the nominations). The
 * handler is a pure async fn so tests can drive both modes without a transport.
 */
export async function reviewA11y(
  input: ReviewInput,
): Promise<ReviewRetrieveResult | ReviewVerifyResult> {
  const files = input.files.map((f) => resolve(f));
  if (input.verify === true) return verify(files, input.candidates);
  return retrieve(files);
}

/**
 * Resolve a directory to its `.tsx` files and run the retrieve step — the
 * convenience entry the MCP `dir` argument maps to (mirrors `checkA11y`'s
 * collect-then-run shape). Verify mode takes explicit `files`, not a `dir`,
 * since the agent already knows which files its candidates point at.
 */
export async function reviewA11yDir(dir: string): Promise<ReviewRetrieveResult> {
  const root = resolve(dir);
  const files = await collectTsx(root);
  return retrieve(files);
}
