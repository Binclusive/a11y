/**
 * `review_a11y` — the corpus-grounded RECALL layer (RFC Phase 1, §1e), and the
 * gate stack that disposes of the model's nominations.
 *
 * THE GATE STACK, by who runs it (ADR 0003 — the model PROPOSES, deterministic
 * code DISPOSES):
 *
 *   - G0-G6 are SERVER-DETERMINISTIC counted vetoes ({@link GateId}). They run
 *     here in {@link gate}, never trust a model verdict, and are the only gates
 *     with a drop counter.
 *   - G7 (adversarial self-verify) is the AGENT'S step, not a server gate: it is
 *     a required {@link ReviewCandidate.justification} field the contract forces,
 *     which the deterministic gates never read. It has no server counter.
 *   - G8 (advisory framing) is not a veto at all — it is the SHAPING of a survivor
 *     into a quarantined `corpus-agent`/`recall`/`warn` finding ({@link toRecallFinding}).
 *
 * This module is the "disposes" half. It never trusts a model verdict for
 * precision — every survivor has cleared the G0-G6 mechanical gates that run
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
 *      back through the G0-G6 server gates DETERMINISTICALLY and returns only the
 *      survivors, shaped (G8) as advisory recall {@link Finding}s (provenance
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
import { type IntrinsicElement, collectIntrinsicElements } from "./intrinsic-elements";
import {
  type LocatedAbstention,
  type ResolvedHost,
  buildResolvedHosts,
  enforceContentWithAbstentions,
} from "./enforce";
import {
  type ComponentResolution,
  collectUsedComponents,
  jsxKeyFor,
} from "./resolve-components";
import { type RetrievedPattern, retrieveSlice } from "./retrieve";
import { type SuppressorMap, buildSuppressorMap } from "./suppressor-map";

/**
 * The grounding-slice inputs for ONE file: that file's own resolutions (the
 * wrappers it imports + uses), its own static findings, and its own intrinsic
 * elements. {@link gate} builds a PER-FILE slice from this so the closed
 * vocabulary (G1) is scoped to the file a candidate is cited on — a pattern
 * grounded only by a SIBLING file can never authorize a candidate here.
 */
interface FileSliceInputs {
  readonly resolutions: readonly ComponentResolution[];
  readonly findings: readonly Finding[];
  readonly intrinsics: readonly IntrinsicElement[];
}

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
  /**
   * The intrinsic (lowercase-tag) elements across all scanned files — R4's input
   * for the grounding slice. Collected off the SHARED parses (no second parse).
   */
  readonly intrinsics: readonly IntrinsicElement[];
  /**
   * The PER-FILE grounding-slice inputs (`file -> {resolutions, findings,
   * intrinsics}`), keyed by RESOLVED path. {@link gate} builds each candidate's
   * vocabulary from the slice of ITS OWN file, so a multi-file `review_a11y`
   * call can never cross-authorize (a pattern grounded by file B's element does
   * not license a candidate cited in file A). A single-file call has one entry
   * whose inputs equal the global inputs, so the slice — and behavior — is
   * byte-identical to the global path.
   */
  readonly perFile: ReadonlyMap<string, FileSliceInputs>;
}

/**
 * A per-file, per-line suppressor map plus the JSX-element line index for that
 * file. Built off the GIVEN `ts.SourceFile` so the line numbering is consistent
 * with every other walk over the same parse (one parse per file per round trip).
 */
function fileFacts(
  sf: ts.SourceFile,
  resolvedHosts: ReadonlyMap<string, ResolvedHost>,
): {
  readonly suppressors: SuppressorMap;
  readonly jsxLines: ReadonlySet<number>;
  readonly sourceLines: readonly string[];
} {
  const suppressors = buildSuppressorMap(sf, resolvedHosts);

  // Every line spanned by a real JSX element's opening tag (intrinsic or
  // component). G2 reads this so a candidate quote on a non-JSX line (a comment,
  // an import) is dropped. The FULL opening span is indexed — not just its first
  // line — so a multi-line opening tag (an attribute on a continuation line) is a
  // valid anchor on every one of its lines.
  const jsxLines = new Set<number>();
  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      const first = sf.getLineAndCharacterOfPosition(opening.getStart(sf)).line;
      const last = sf.getLineAndCharacterOfPosition(opening.getEnd()).line;
      for (let line = first; line <= last; line++) jsxLines.add(line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  return { suppressors, jsxLines, sourceLines: sf.text.split("\n") };
}

/** Build the static fact bundle for the gate stack from a set of files. */
async function buildStaticFacts(files: readonly string[]): Promise<StaticFacts> {
  const result = await scan(files);

  // Work over EXACTLY what `scan()` processed — its per-file parse cache, already
  // filtered by `binclusive.json` ignore globs and read failures. Deriving the file
  // set from this cache (not the raw input list) shares the one parse across the
  // enforce-abstentions walk (G4), the suppressor / jsxLines walk (G3/G2), AND the
  // R4 intrinsics walk, AND keeps all of them in agreement — so an IGNORED file can
  // never ground a recall pattern through one walk that the others excluded.
  const sourceFiles = new Map(result.resolved.sourceFiles);
  const tsx = [...sourceFiles.keys()];

  // G4 — abstentions, re-derived from the floor's own enforce pass (same input
  // scan used), over the SHARED parses. Keyed `file -> { "line:sc" }`.
  const { abstentions } = enforceContentWithAbstentions(
    tsx,
    {
      resolutions: result.resolved.resolutions,
      declarations: result.contract?.declarations ?? null,
      contract: result.contract,
    },
    sourceFiles,
  );
  const abstentionsByFile = indexAbstentions(abstentions);

  // Module-scoped resolved-host map — threaded into the suppressor map so it can
  // inherit enforce's RESOLVED-HOST skips (traced/registry toggle, rendersOwnName,
  // input-host `type` exemption), not just call-site syntax.
  const resolvedHosts = buildResolvedHosts(result.resolved.resolutions);

  // PER-FILE slice scoping (G1 vocabulary leak fix): resolutions are GLOBALLY
  // deduped by `name@module`, so a resolution carries no file home. Attribute each
  // to the files that actually USE it by re-walking each file's already-cached
  // parse (`collectUsedComponents`, pure) and matching on the jsx-a11y key — the
  // same key the resolver maps on. R1's only inputs are a resolution's name/host
  // tokens, so a name-keyed attribution is exactly the per-file R1 universe.
  const resolutionsByKey = new Map<string, ComponentResolution[]>();
  for (const r of result.resolved.resolutions) {
    const key = jsxKeyFor(r.name);
    const bucket = resolutionsByKey.get(key);
    if (bucket === undefined) resolutionsByKey.set(key, [r]);
    else bucket.push(r);
  }
  // Findings carry their own `file`; group by resolved path to match the
  // sourceFiles keys (input.files is resolved before scan; floor findings are
  // absolute-keyed too).
  const findingsByFile = new Map<string, Finding[]>();
  for (const f of result.findings) {
    const fileKey = resolve(f.file);
    const bucket = findingsByFile.get(fileKey);
    if (bucket === undefined) findingsByFile.set(fileKey, [f]);
    else bucket.push(f);
  }

  const suppressors = new Map<string, SuppressorMap>();
  const jsxLines = new Map<string, ReadonlySet<number>>();
  const sourceLines = new Map<string, readonly string[]>();
  // R4 — collect intrinsic elements off the SAME shared parse the gate facts use.
  const intrinsics: IntrinsicElement[] = [];
  const perFile = new Map<string, FileSliceInputs>();
  for (const [file, sf] of sourceFiles) {
    const facts = fileFacts(sf, resolvedHosts);
    suppressors.set(file, facts.suppressors);
    jsxLines.set(file, facts.jsxLines);
    sourceLines.set(file, facts.sourceLines);
    const fileIntrinsics = collectIntrinsicElements(sf);
    intrinsics.push(...fileIntrinsics);

    // This file's own grounding-slice inputs. Resolutions: the deduped resolution
    // for each wrapper this file uses (a file may use the same wrapper as another;
    // the resolution is shared — correct, the host is the same). Findings: this
    // file's own. Intrinsics: this file's own.
    const usedKeys = new Set(collectUsedComponents(sf).map((u) => jsxKeyFor(u.local)));
    const fileResolutions: ComponentResolution[] = [];
    for (const key of usedKeys) {
      const matched = resolutionsByKey.get(key);
      if (matched !== undefined) fileResolutions.push(...matched);
    }
    perFile.set(resolve(file), {
      resolutions: fileResolutions,
      findings: findingsByFile.get(resolve(file)) ?? [],
      intrinsics: fileIntrinsics,
    });
  }

  return {
    findings: result.findings,
    resolutions: result.resolved.resolutions,
    suppressors,
    abstentions: abstentionsByFile,
    jsxLines,
    sourceLines,
    intrinsics,
    perFile,
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
  /** Survivors of the G0-G6 server gate stack (G8-shaped) — advisory `corpus-agent` / `recall` findings. */
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

/**
 * The SERVER-DETERMINISTIC gates a candidate can die at, in stack order — the
 * only gates with a drop counter. G7 (agent adversarial self-verify) and G8
 * (advisory framing of the survivor) are deliberately NOT here: G7 is the calling
 * agent's step (the {@link ReviewCandidate.justification} field), and G8 is the
 * survivor-shaping in {@link toRecallFinding}, not a veto. Neither is counted.
 */
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
  // Work over EXACTLY what `scan()` processed (its parse cache, post binclusive.json
  // ignore + read failures) for EVERY walk — R3 journey hints, the suppressor map,
  // and R4 intrinsics — so they agree and an ignored file never grounds a pattern.
  const sourceFiles = result.resolved.sourceFiles;
  const tsx = [...sourceFiles.keys()];

  // R4 — each file's intrinsic (lowercase-tag) elements + their coarse content
  // signal feed the explicit tag→pattern table.
  const intrinsics: IntrinsicElement[] = [];
  for (const sf of sourceFiles.values()) {
    intrinsics.push(...collectIntrinsicElements(sf));
  }
  const slice = retrieveSlice({
    files: tsx,
    resolutions: result.resolved.resolutions,
    findings: result.findings,
    intrinsics,
  });

  // Per-file suppressor facts, serialized for the wire (Map/Set -> plain object),
  // off the same shared parse the slice used.
  const resolvedHosts = buildResolvedHosts(result.resolved.resolutions);
  const suppressorMap: Record<string, Record<number, readonly string[]>> = {};
  for (const file of tsx) {
    const sf = sourceFiles.get(file);
    if (sf == null) continue;
    const facts = fileFacts(sf, resolvedHosts);
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
 * The G0-G6 server gate stack, run DETERMINISTICALLY over the model nominations.
 * Each gate is a hard veto; a candidate must clear ALL of them to survive. The
 * order is the cheapest-first / most-fundamental-first stack from the RFC. (G7,
 * the agent's self-verify, ran before these candidates arrived; G8 below is the
 * survivor-shaping, not a veto.)
 *
 *   - G0 ANCHOR — an empty slice for the candidate's OWN FILE means no grounding
 *     for that file; nothing on it may flag.
 *   - G1 CLOSED-VOCABULARY — drop unless the patternId is in the candidate's
 *     OWN FILE's slice (per-file vocabulary — a sibling file's grounding can
 *     never cross-authorize).
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
  facts: StaticFacts,
): { readonly survivors: Finding[]; readonly dropped: Record<GateId, number> } {
  const dropped: Record<GateId, number> = { G0: 0, G1: 0, G2: 0, G3: 0, G4: 0, G5: 0, G6: 0 };

  // PER-FILE slice (G1 vocabulary leak fix): a candidate's closed vocabulary is
  // the slice of ITS OWN file, never a global union. Built lazily and memoized
  // per resolved path — `retrieveSlice` is pure, so the same file yields the same
  // slice; the cache just avoids recomputing it for every candidate on that file.
  const sliceByFile = new Map<string, Map<string, RetrievedPattern>>();
  const sliceFor = (fileKey: string): Map<string, RetrievedPattern> => {
    const cached = sliceByFile.get(fileKey);
    if (cached !== undefined) return cached;
    const inputs = facts.perFile.get(fileKey);
    const patterns =
      inputs === undefined
        ? []
        : retrieveSlice({
            files: [fileKey],
            resolutions: inputs.resolutions,
            findings: inputs.findings,
            intrinsics: inputs.intrinsics,
          }).patterns;
    const byId = new Map(patterns.map((p) => [p.id, p]));
    sliceByFile.set(fileKey, byId);
    return byId;
  };

  const survivors: Finding[] = [];
  for (const c of candidates) {
    // The static-fact maps are keyed by RESOLVED absolute path (only `input.files`
    // is resolved before scan). Normalize the candidate's path the same way ONCE,
    // so a relative/non-normalized `c.file` still hits every veto map below.
    const fileKey = resolve(c.file);
    const byId = sliceFor(fileKey);

    // G0 ANCHOR — this file's slice is empty ⇒ no grounding for this file ⇒ the
    // candidate dies here (per-file: a sibling file's grounding does not rescue it).
    if (byId.size === 0) {
      dropped.G0++;
      continue;
    }

    // G1 — closed vocabulary: the patternId must be in THIS FILE's slice.
    const pattern = byId.get(c.patternId);
    if (pattern === undefined) {
      dropped.G1++;
      continue;
    }

    // G2 — mechanical: the cited line must be a real JSX element AND the quote
    // must be a verbatim substring of that exact line.
    const lines = facts.sourceLines.get(fileKey);
    const jsx = facts.jsxLines.get(fileKey);
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
    const suppressors = facts.suppressors.get(fileKey)?.get(c.line);
    if (suppressors !== undefined && suppressors.size > 0) {
      dropped.G3++;
      continue;
    }

    // G4 — abstention veto: the floor CONSIDERED this line+sc and declined.
    const abstained = facts.abstentions.get(fileKey);
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
    // Emit the RESOLVED path (the same normalization the facts lookups use), so a
    // relative-path nomination dedups against the absolute-keyed floor findings
    // rather than escaping the quarantine and surfacing a duplicate of a
    // floor-caught issue.
    file: resolve(c.file),
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
  const { survivors, dropped } = gate(candidates, facts);
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
