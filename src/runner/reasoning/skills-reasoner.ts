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
 *   4. Parse the reply into patch-free suggestions and fold each onto a
 *      `corpus-agent` finding.
 *
 * Suggestions-not-patches is structural, not enforced here: this reasoner holds
 * no filesystem handle (its `ReasonContext` grants a provider + lookup + finding,
 * nothing else), and a {@link FixSuggestion} has no patch channel. Nothing it can
 * do writes to the mounted source.
 */
import type { Finding } from "../../core";
import { corpusFix, type EnrichedFinding, enrich } from "../../corpus";
import type { LookupTool } from "../lookup";
import type { AgentFinding, AgentReasoner, ReasonContext } from "../reasoner";
import { frameworkGuidanceFor } from "./index";
import { buildSystemPrompt, buildUserPrompt, parseSuggestions, suggestionMessage } from "./prompt";
import type { FixSuggestion } from "./types";

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

/** Fold one suggestion onto a `corpus-agent` finding, reusing the input's read-side locators. */
function toAgentFinding(source: EnrichedFinding, suggestion: FixSuggestion): AgentFinding {
  const base: Finding = {
    file: source.file,
    line: source.line,
    ruleId: source.ruleId,
    message: suggestionMessage(suggestion),
    wcag: suggestion.wcag.length > 0 ? suggestion.wcag : source.wcag,
    enforcement: source.enforcement,
    provenance: "corpus-agent",
    layer: "recall",
    ...(suggestion.patternId !== undefined ? { patternId: suggestion.patternId } : {}),
    ...(source.selector !== undefined ? { selector: source.selector } : {}),
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

  const reason = async (ctx: ReasonContext): Promise<readonly AgentFinding[]> => {
    const guidance = frameworkGuidanceFor(ctx.finding);
    if (guidance === null) return [];

    const structural = config.useLookup ? await structuralContext(ctx.lookup, ctx.finding) : null;
    const system = buildSystemPrompt(guidance);
    const user = buildUserPrompt(ctx.finding, corpusFix(ctx.finding.corpus), structural);

    const response = await ctx.provider.complete({
      system,
      messages: [{ role: "user", content: user }],
      maxOutputTokens: config.maxOutputTokens,
    });

    return parseSuggestions(response.text).map((suggestion) => toAgentFinding(ctx.finding, suggestion));
  };

  return { reason };
}
