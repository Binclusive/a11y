/**
 * The concrete {@link AgentReasoner} — the audit-reasoning core wired into the
 * runner's seam (issue #2096). It fills the seam #2095 left; it does NOT redesign
 * the runner. The `AgentReasoner` interface needed no extension: the reasoning is
 * injected as data (the framework guidance) and the output is already the
 * seam's `AgentFinding[]`.
 *
 * One pass, per the harness contract:
 *   1. Select the framework guidance for the finding; `null` ⇒ nothing to add.
 *   2. Optionally ask ONE structural lookup (the #2097 seam) for context.
 *   3. Consult the model with the guidance as `system` framing.
 *   4. Parse the reply (zod boundary, issue #2098) into a patch-free enrichment of
 *      the SOURCE finding plus zero+ DISCOVERIES, each folded onto a new
 *      `corpus-agent` finding.
 *
 * Suggestions-not-patches is structural, not enforced here: this reasoner holds
 * no filesystem handle (its `ReasonContext` grants a provider + lookup + finding,
 * nothing else), and a {@link FixSuggestion} has no patch channel. Nothing it can
 * do writes to the mounted source.
 */
import type { Finding } from "../../core";
import { evidenceFix, type EnrichedFinding, enrich } from "../../evidence";
import type { LookupTool } from "../lookup";
import { type AgentFinding, type AgentReasoner, EMPTY_RESULT, type ReasonContext, type ReasonResult } from "../reasoner";
import { frameworkGuidanceFor } from "./index";
import { buildSystemPrompt, buildUserPrompt, parseReasonResponse, suggestionMessage } from "./prompt";
import type { Discovery } from "./types";

/** Tuning for the reasoner. All bounded — the harness meters spend underneath. */
export interface SkillsReasonerOptions {
  /** Upper bound on model output tokens per pass. Default 1024 — a suggestion is short. */
  readonly maxOutputTokens?: number;
  /** Ask one structural lookup for context before reasoning. Default true. */
  readonly useLookup?: boolean;
}

const DEFAULT_OPTIONS: Required<SkillsReasonerOptions> = {
  maxOutputTokens: 1024,
  useLookup: true,
};

/** One structural lookup for context. Tolerant: a cap or a throw yields no context, never a failure. */
async function structuralContext(lookup: LookupTool, finding: EnrichedFinding): Promise<string | null> {
  try {
    const result = await lookup.lookup({ kind: "renders", target: finding.selector ?? finding.ruleId });
    if (result.status !== "ok") return null;
    return JSON.stringify(result.data).slice(0, 500);
  } catch {
    return null;
  }
}

/** The prose a discovered finding carries — observation + rationale + fix in one message. */
function discoveryMessage(d: Discovery): string {
  return `${d.observation} Rationale: ${d.rationale} Suggested fix (${d.fixType}): ${d.suggestedFix}`;
}

/**
 * Fold one DISCOVERY onto a new `corpus-agent` finding. It anchors on the source
 * finding's read-side locators (file/line, or the discovery's named element), and
 * carries the two discovery fields the floor can't: `confidence` and the rationale
 * (folded into the message). Advisory by construction — `enforcement: "warn"`,
 * never inherited `block`, so it can never gate the exit code.
 */
function toAgentFinding(source: EnrichedFinding, d: Discovery): AgentFinding {
  const base: Finding = {
    file: source.file,
    line: source.line,
    ruleId: source.ruleId,
    message: discoveryMessage(d),
    wcag: d.wcag.length > 0 ? d.wcag : source.wcag,
    enforcement: "warn",
    provenance: "corpus-agent",
    layer: "recall",
    confidence: d.confidence,
    ...(d.patternId !== undefined ? { patternId: d.patternId } : {}),
    ...(d.element !== undefined
      ? { selector: d.element }
      : source.selector !== undefined
        ? { selector: source.selector }
        : {}),
    ...(source.severity !== undefined ? { severity: source.severity } : {}),
  };
  return { ...enrich(base), provenance: "corpus-agent" };
}

/**
 * Build the reasoning core as an {@link AgentReasoner}. The runner's AI lane
 * consults the framework checklists + pattern catalogs through this — with no
 * Claude-Code (or any external agent) harness dependency.
 */
export function createSkillsReasoner(options: SkillsReasonerOptions = {}): AgentReasoner {
  const config = { ...DEFAULT_OPTIONS, ...options };

  const reason = async (ctx: ReasonContext): Promise<ReasonResult> => {
    const guidance = frameworkGuidanceFor(ctx.finding);
    if (guidance === null) return EMPTY_RESULT;

    const structural = config.useLookup ? await structuralContext(ctx.lookup, ctx.finding) : null;
    const system = buildSystemPrompt(guidance);
    const user = buildUserPrompt(ctx.finding, evidenceFix(ctx.finding.corpus), structural);

    const response = await ctx.provider.complete({
      system,
      messages: [{ role: "user", content: user }],
      maxOutputTokens: config.maxOutputTokens,
    });

    const parsed = parseReasonResponse(response.text);
    // Enrich the SOURCE finding in place (prose note); discover NEW findings around it.
    const enrichment = parsed.enrichment !== null ? suggestionMessage(parsed.enrichment) : null;
    const discoveries = parsed.discoveries.map((d) => toAgentFinding(ctx.finding, d));
    return { enrichment, discoveries };
  };

  return { reason };
}
