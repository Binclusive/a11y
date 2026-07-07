/**
 * Projecting the reasoning core into a model conversation and reading its answer
 * back (issue #2096). Three pure pieces, no I/O:
 *
 *   - {@link buildSystemPrompt} folds a {@link FrameworkGuidance} (checklist +
 *     pattern catalog) into the `system` framing — this is where the ported
 *     skills prose actually reaches the model.
 *   - {@link buildUserPrompt} states the one deterministic finding to reason about.
 *   - {@link parseReasonResponse} reads the model's reply into a typed, patch-free
 *     {@link ParsedReasonResponse} — an in-place {@link FixSuggestion} enrichment
 *     (or none) plus a {@link Discovery} array — over a tolerant zod boundary
 *     (issue #2098). Every layer degrades to the valid subset: an unparseable
 *     reply, a malformed envelope, a bad enrichment, or bad discovery entries each
 *     yield the empty/partial result, never a throw, so bad model output can't fail
 *     the non-blocking run.
 *
 * The response contract asked of the model is SUGGESTION-ONLY: it returns prose
 * fixes, never edits. {@link parseReasonResponse} has no path to a patch — it only
 * ever produces prose, so "fix = suggestions only" survives the parse boundary.
 */
import { z } from "zod";
import type { Finding } from "../../core";
import {
  type Discovery,
  FIX_TYPES,
  type FixSuggestion,
  type FixType,
  type FrameworkGuidance,
  type PatternCatalogEntry,
} from "./types";

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
    "You SUGGEST fixes; you never apply them. Do TWO things for the finding below and",
    "return ONLY a JSON object (no prose outside it) with this exact shape:",
    "  {",
    '    "enrichment": { "observation": string, "suggestedFix": string, "wcag": string[],',
    `      "fixType": one of ${FIX_TYPES.map((t) => `"${t}"`).join(" | ")}, "patternId"?: string } | null,`,
    '    "discoveries": [ { "observation": string, "suggestedFix": string, "rationale": string,',
    '      "confidence": "low" | "medium" | "high", "wcag": string[],',
    `      "fixType": one of ${FIX_TYPES.map((t) => `"${t}"`).join(" | ")}, "element"?: string, "patternId"?: string } ]`,
    "  }",
    "",
    "ENRICHMENT enriches the GIVEN deterministic finding in place — a note/fix for",
    "THAT exact issue. Use null when you have nothing to add to it.",
    "DISCOVERIES are NEW accessibility problems the rule engine MISSED — compositional",
    "or contextual issues (e.g. a broken focus order across components, a duplicated",
    "landmark, a heading-level skip) that no single-element rule would catch. Use [] when",
    "you find nothing new; do NOT restate the given finding as a discovery.",
    "Never emit a diff, patch, or file edit — only described fixes. Set patternId to the",
    "matching catalog id when one applies.",
  ].join("\n");
}

/** The user turn: the single deterministic finding this pass reasons about. */
export function buildUserPrompt(finding: Finding, evidenceFix: string | null, structural: string | null): string {
  const lines = [
    "Reason about this deterministic finding and suggest fixes:",
    `- rule: ${finding.ruleId}`,
    `- message: ${finding.message}`,
    `- wcag: ${finding.wcag.length > 0 ? finding.wcag.join(", ") : "(none mapped)"}`,
  ];
  if (evidenceFix !== null) lines.push(`- corpus fix hint: ${evidenceFix}`);
  if (structural !== null) lines.push(`- structural context: ${structural}`);
  return lines.join("\n");
}

/** The prose an agent finding carries — the suggestion folded into one message. */
export function suggestionMessage(s: FixSuggestion): string {
  return `${s.observation} Suggested fix (${s.fixType}): ${s.suggestedFix}`;
}

/**
 * Coerce a model-supplied `fixType` to a known label. An unknown/absent value
 * defaults to the most conservative label — a fix we can't classify is one the
 * developer must verify, never a silent "SAFE". Reuses {@link FIX_TYPES} as the
 * single source of valid labels (no duplicated literal list to drift).
 */
function coerceFixType(value: unknown): FixType {
  for (const t of FIX_TYPES) if (t === value) return t;
  return "RUNTIME-CHECK";
}

/**
 * The zod boundary for one suggestion. `.min(1)` rejects empty prose; `fixType`
 * is coerced not rejected (a bad label degrades to RUNTIME-CHECK); `wcag` that
 * isn't a clean string array degrades to `[]`. This is the structured-output
 * parse the AC demands — malformed entries are rejected at `safeParse`, never
 * trusted.
 */
const fixSuggestionSchema = z.object({
  observation: z.string().min(1),
  suggestedFix: z.string().min(1),
  wcag: z.array(z.string()).catch([]),
  fixType: z.unknown().transform(coerceFixType),
  patternId: z.string().optional(),
});

/** A discovery is a suggestion plus the standalone-judgement fields (rationale + confidence). */
const discoverySchema = fixSuggestionSchema.extend({
  rationale: z.string().min(1),
  confidence: z.enum(["low", "medium", "high"]),
  element: z.string().optional(),
});

/**
 * The top-level envelope. Deliberately PERMISSIVE — every field is `unknown` and
 * the whole thing `.catch`es to empty — so a malformed enrichment can never sink
 * an otherwise-good discoveries array (and vice versa). Each field is re-parsed
 * INDEPENDENTLY below, so tolerance is per-entry, not all-or-nothing.
 */
const envelopeSchema = z
  .object({ enrichment: z.unknown().optional(), discoveries: z.unknown().optional() })
  .catch({ enrichment: undefined, discoveries: undefined });

/** The parsed two-behavior response — an in-place enrichment (or none) plus discoveries. */
export interface ParsedReasonResponse {
  readonly enrichment: FixSuggestion | null;
  readonly discoveries: readonly Discovery[];
}

/** Pull the first JSON object out of a model reply (fenced ```json block or bare). */
function extractJsonObject(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
  if (fenced) return fenced[1];
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start !== -1 && end > start ? text.slice(start, end + 1) : null;
}

function parseOne<T>(schema: z.ZodType<T>, value: unknown): T | null {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Read a model reply into a typed {@link ParsedReasonResponse}. Tolerant on
 * purpose and at every layer: an unparseable reply, a malformed envelope, a bad
 * enrichment, or bad discovery entries all degrade to the valid subset — it never
 * throws, because the AI lane must never fail the non-blocking run.
 */
export function parseReasonResponse(text: string): ParsedReasonResponse {
  const json = extractJsonObject(text);
  if (json === null) return { enrichment: null, discoveries: [] };
  let root: unknown;
  try {
    root = JSON.parse(json);
  } catch {
    return { enrichment: null, discoveries: [] };
  }
  const envelope = envelopeSchema.parse(root);
  const enrichment = parseOne(fixSuggestionSchema, envelope.enrichment);
  const rawDiscoveries = Array.isArray(envelope.discoveries) ? envelope.discoveries : [];
  const discoveries: Discovery[] = [];
  for (const entry of rawDiscoveries) {
    const discovery = parseOne(discoverySchema, entry);
    if (discovery !== null) discoveries.push(discovery);
  }
  return { enrichment, discoveries };
}
