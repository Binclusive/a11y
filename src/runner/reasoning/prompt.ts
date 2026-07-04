/**
 * Projecting the reasoning core into a model conversation and reading its answer
 * back (issue #2096). Three pure pieces, no I/O:
 *
 *   - {@link buildSystemPrompt} folds a {@link FrameworkGuidance} (checklist +
 *     pattern catalog) into the `system` framing — this is where the ported
 *     skills prose actually reaches the model.
 *   - {@link buildUserPrompt} states the one deterministic finding to reason about.
 *   - {@link parseSuggestions} reads the model's reply into typed, patch-free
 *     {@link FixSuggestion}s — tolerant by design (a malformed reply yields `[]`,
 *     never a throw, so a bad model output can't fail the non-blocking run).
 *
 * The response contract asked of the model is SUGGESTION-ONLY: it returns prose
 * fixes, never edits. {@link parseSuggestions} has no path to a patch — it only
 * ever produces prose, so "fix = suggestions only" survives the parse boundary.
 *
 * NOTE — the parse here is the minimal enrich (one finding in → suggestions on
 * that finding). Robust structured-output parsing, multi-finding DISCOVERY, and
 * dedup are the enrich+discover surface of issue #2098; this leaves that seam
 * clean rather than pre-empting it.
 */
import type { Finding } from "../../core";
import { FIX_TYPES, type FixSuggestion, type FixType, type FrameworkGuidance, type PatternCatalogEntry } from "./types";

/** Render one pattern-catalog entry as the model sees it. */
function renderPattern(p: PatternCatalogEntry): string {
  const lines = [
    `### ${p.id}: ${p.title}`,
    `- Component type: ${p.componentType}`,
    `- WCAG: ${p.wcag.join(", ")}`,
    `- Severity default: ${p.severityDefault}`,
    `- Fix type default: ${p.fixTypeDefault}${p.fixTypeNote ? ` (${p.fixTypeNote})` : ""}`,
    `- Bad shape: ${p.badShape}`,
    `- Detection hints: ${p.detectionHints}`,
    `- Correct fix: ${p.correctFix}`,
    `- Verification: ${p.verification}`,
    `- False positives / exceptions: ${p.exceptions}`,
  ];
  return lines.join("\n");
}

/**
 * The `system` framing: the framework's checklist + pattern catalog, plus the
 * suggestion-only output contract. This IS the reshaped skill — the reasoning
 * prose the runner's AI lane consults, carried in-engine.
 */
export function buildSystemPrompt(guidance: FrameworkGuidance): string {
  const checklist = guidance.checklist
    .map((area) => `## ${area.title}\n${area.items.map((i) => `- ${i}`).join("\n")}`)
    .join("\n\n");
  const patterns = guidance.patterns.map(renderPattern).join("\n\n");

  return [
    `You are an accessibility auditor reviewing ${guidance.framework} code.`,
    `Applies to: ${guidance.appliesTo}`,
    "",
    "Use the checklist and pattern catalog below as your reasoning core. Ground every",
    "suggestion in a specific checklist item or catalogued pattern.",
    "",
    `# ${guidance.framework} Audit Checklist`,
    checklist,
    "",
    "# Pattern Catalog",
    patterns,
    "",
    "# Output contract",
    "You SUGGEST fixes; you never apply them. Return ONLY a JSON array (no prose",
    "outside it) of suggestion objects with this shape:",
    '  { "observation": string, "suggestedFix": string, "wcag": string[],',
    `    "fixType": one of ${FIX_TYPES.map((t) => `"${t}"`).join(" | ")}, "patternId"?: string }`,
    "Return [] when there is nothing to add. Never emit a diff, patch, or file edit —",
    "only a described fix. Set patternId to the matching catalog id when one applies.",
  ].join("\n");
}

/** The user turn: the single deterministic finding this pass reasons about. */
export function buildUserPrompt(finding: Finding, corpusFix: string | null, structural: string | null): string {
  const lines = [
    "Reason about this deterministic finding and suggest fixes:",
    `- rule: ${finding.ruleId}`,
    `- message: ${finding.message}`,
    `- wcag: ${finding.wcag.length > 0 ? finding.wcag.join(", ") : "(none mapped)"}`,
  ];
  if (corpusFix !== null) lines.push(`- corpus fix hint: ${corpusFix}`);
  if (structural !== null) lines.push(`- structural context: ${structural}`);
  return lines.join("\n");
}

/** The prose an agent finding carries — the suggestion folded into one message. */
export function suggestionMessage(s: FixSuggestion): string {
  return `${s.observation} Suggested fix (${s.fixType}): ${s.suggestedFix}`;
}

function isFixType(value: unknown): value is FixType {
  return typeof value === "string" && (FIX_TYPES as readonly string[]).includes(value);
}

function asStringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** Narrow one parsed JSON value into a {@link FixSuggestion}, or `null` if malformed. */
function toSuggestion(value: unknown): FixSuggestion | null {
  if (typeof value !== "object" || value === null) return null;
  const record: Record<string, unknown> = value as Record<string, unknown>;
  const observation = record.observation;
  const suggestedFix = record.suggestedFix;
  if (typeof observation !== "string" || observation.length === 0) return null;
  if (typeof suggestedFix !== "string" || suggestedFix.length === 0) return null;
  // An unknown/absent fixType defaults to the most conservative label — a fix we
  // can't classify is one the developer must verify, never a silent "SAFE".
  const fixType = isFixType(record.fixType) ? record.fixType : "RUNTIME-CHECK";
  const patternId = typeof record.patternId === "string" ? record.patternId : undefined;
  return { observation, suggestedFix, wcag: asStringArray(record.wcag), fixType, patternId };
}

/** Pull the first JSON array out of a model reply (fenced ```json block or bare). */
function extractJsonArray(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/);
  if (fenced) return fenced[1];
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  return start !== -1 && end > start ? text.slice(start, end + 1) : null;
}

/**
 * Read a model reply into typed suggestions. Tolerant on purpose: a reply that
 * isn't parseable JSON, or whose entries are malformed, yields the valid subset
 * (possibly `[]`) — it never throws, because the AI lane must never fail the run.
 */
export function parseSuggestions(text: string): readonly FixSuggestion[] {
  const json = extractJsonArray(text);
  if (json === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: FixSuggestion[] = [];
  for (const entry of parsed) {
    const suggestion = toSuggestion(entry);
    if (suggestion !== null) out.push(suggestion);
  }
  return out;
}
