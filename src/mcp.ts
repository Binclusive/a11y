/**
 * A local, stdio MCP server that exposes the a11y-checker to any MCP client
 * (Cursor, Copilot, Claude, Windsurf) running on the developer's machine.
 *
 * It reads the developer's LOCAL files and runs the checker we already built —
 * no auth, no network. This is the inverse of `@b8e/mcp`, which is a remote,
 * OAuth-gated Worker/Durable-Object server for account management; the only
 * thing shared is the `@modelcontextprotocol/sdk` shape (`server.tool(...)` +
 * `{ content: [{ type: "text", text }] }`).
 *
 * Every tool is a THIN wrapper over the package's existing functions — no new
 * a11y logic lives here. The handlers are factored out (`checkA11y`,
 * `getA11yRules`, `learnA11yRule`) so tests can call them directly without a
 * live transport; `registerTools` only adapts their return value into the MCP
 * `content` envelope.
 *
 * Install snippet for a client's `.mcp.json` (stdio):
 *
 *   {
 *     "mcpServers": {
 *       "binclusive-a11y": {
 *         "command": "npx",
 *         "args": ["-y", "@binclusive/a11y", "mcp"]
 *       }
 *     }
 *   }
 */

import { relative, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { collectTsx } from "./collect";
import { scanUrl } from "./collect-dom";
import { learn } from "./commands";
import { scan } from "./core";
import {
  type BaselineRuleInfo,
  baselineRules,
  corpusBestPractice,
  type CorpusEvidence,
  type CorpusPattern,
  corpusHelpUrl,
  corpusPatterns,
  corpusSeverity,
  corpusTier,
  type CorpusTier,
  type EnrichedFinding,
  enrichAll,
  resolveDisplay,
  type Severity,
} from "./corpus";
import type { Coverage } from "./resolve-components";
import { collectUnityFindings } from "./unity-findings";
import {
  type ReviewCandidate,
  type ReviewInput,
  type ReviewRetrieveResult,
  type ReviewVerifyResult,
  reviewA11y,
  reviewA11yDir,
} from "./review";

/** A single finding flattened to the shape the MCP tool returns. */
export interface CheckFinding {
  readonly file: string;
  readonly line: number;
  readonly ruleId: string;
  readonly wcag: readonly string[];
  /**
   * Which evidence source matched: `audit` (real corpus frequency — the moat),
   * `baseline` (axe's published per-rule catalog — coverage), or `none`. This
   * flat shape is the deliberate FLAT VIEW of the {@link CorpusEvidence} union
   * for external API consumers — the per-source accessors below project it.
   */
  readonly source: CorpusEvidence["source"];
  /** Frequency tier; `unknown` off the audit moat. */
  readonly tier: CorpusTier;
  /** Severity: axe runtime impact, else the baseline catalog default. */
  readonly severity: Severity | null;
  /**
   * True for a baseline match on an axe best-practice rule with no WCAG SC — an
   * axe recommendation, not a WCAG conformance failure.
   */
  readonly bestPractice: boolean;
  /**
   * The rule-accurate fix. For source-pass findings (`jsx-a11y` / `enforce`)
   * this is the SC-keyed corpus fix. For `provenance === "axe"` findings it is
   * axe's OWN per-rule guidance (axe help), NOT the SC-generic corpus fix —
   * which would contradict the rule. Both come from the single
   * {@link resolveDisplay} contract the CLI uses, so the two can't disagree.
   * `helpUrl` carries the canonical Deque fix page either way.
   */
  readonly fix: string | null;
  /** axe's Deque-University help URL, when the source knows it. */
  readonly helpUrl: string | null;
  readonly message: string;
  readonly enforcement: EnrichedFinding["enforcement"];
  /** Which pass produced it: structural `jsx-a11y`, or the call-site `enforce` check. */
  readonly provenance: EnrichedFinding["provenance"];
  /** The axe CSS selector for the offending node. Present only on rendered-DOM/axe findings. */
  readonly selector?: string;
}

/** Flatten an enriched finding to the MCP `CheckFinding` shape. */
function toCheckFinding(f: EnrichedFinding, file: string): CheckFinding {
  return {
    file,
    line: f.line,
    ruleId: f.ruleId,
    wcag: f.wcag,
    source: f.corpus.source,
    tier: corpusTier(f.corpus),
    severity: corpusSeverity(f),
    bestPractice: corpusBestPractice(f.corpus),
    fix: resolveDisplay(f).fix,
    helpUrl: corpusHelpUrl(f),
    message: f.message,
    enforcement: f.enforcement,
    provenance: f.provenance,
    ...(f.selector !== undefined ? { selector: f.selector } : {}),
  };
}

/** The `check_a11y` result: findings plus the component-coverage summary. */
export interface CheckA11yResult {
  readonly root: string;
  readonly filesScanned: number;
  readonly findings: readonly CheckFinding[];
  /** The full coverage tally, incl. the opaque sub-buckets (trusted/icons/declare). */
  readonly coverage: Coverage;
}

/**
 * `check_a11y`: collect `.tsx` under `dir`, run `scan` + `enrichAll`, and
 * return the corpus-tiered findings plus the coverage summary. Mirrors the
 * `check` CLI command's collection + scan + enrich path exactly — no new logic.
 */
export async function checkA11y(dir: string): Promise<CheckA11yResult> {
  const root = resolve(dir);
  const files = await collectTsx(root);
  const result = await scan(files);
  const enriched = enrichAll(result.findings);

  const findings: CheckFinding[] = enriched.map((f) => toCheckFinding(f, relative(root, f.file)));

  return { root, filesScanned: files.length, coverage: result.coverage, findings };
}

/** The `check_url` result: the audited URL plus its rendered-DOM findings. */
export interface CheckUrlResult {
  readonly url: string;
  readonly findings: readonly CheckFinding[];
}

/**
 * `check_url`: render a live URL in a real browser, run axe-core against the
 * DOM (`scanUrl`), and run those findings through `enrichAll` — the same
 * corpus-tiering pass `check_a11y` uses. The only difference is the source: a
 * rendered page instead of `.tsx` files, so `file` is the URL (kept as-is, NOT
 * relativized) and each finding carries the axe `selector`. No new a11y logic.
 */
export async function checkUrl(url: string): Promise<CheckUrlResult> {
  const result = await scanUrl(url);
  const enriched = enrichAll(result.findings);

  // `file` stays the URL (NOT relativized) for the rendered-DOM path.
  const findings: CheckFinding[] = enriched.map((f) => toCheckFinding(f, f.file));

  return { url: result.url, findings };
}

/** The `check_unity` result: the scanned project root plus its enriched findings. */
export interface CheckUnityResult {
  readonly root: string;
  readonly findings: readonly CheckFinding[];
}

/**
 * `check_unity`: run the Unity finding-emission aggregator over a project dir
 * (`collectUnityFindings` — `scanUnity` → the Unity rules → one canonical
 * `Finding[]`), then run those findings through `enrichAll` — the SAME corpus-tiering
 * pass `check_a11y`/`check_url` use. This is the Unity analog of `check_a11y`: the only
 * difference is the source (serialized `.prefab`/`.unity` assets instead of `.tsx`),
 * so the returned `findings` carry `provenance: "unity"` and `file` is relativized to
 * the project root, exactly as `check_a11y` relativizes the `.tsx` paths. No Unity
 * logic lives here — it is a thin wrapper over the shared aggregator + enrichment, the
 * same reuse discipline as every other tool (epic #87 / #92).
 */
export async function checkUnity(dir: string): Promise<CheckUnityResult> {
  const root = resolve(dir);
  const raw = await collectUnityFindings(root);
  const enriched = enrichAll(raw);

  const findings: CheckFinding[] = enriched.map((f) => toCheckFinding(f, relative(root, f.file)));

  return { root, findings };
}

/** How many patterns `get_a11y_rules` returns when no filter is given. */
const TOP_RULES = 15;

/**
 * The `get_a11y_rules` result. The PRIMARY, richer answer is the distilled
 * corpus patterns (`patterns`) — the real-audit moat. `baseline` is the coverage
 * fallback: axe's published per-rule entries (severity + standard fix + helpUrl,
 * NO org count) for the requested component/SC/ruleId, so the tool can answer
 * for any axe/WCAG rule, not only the distilled ones. `baseline` is populated
 * whenever a query has no distilled match (or always, when asked by ruleId).
 */
export interface GetA11yRulesResult {
  readonly matchedOn: "component" | "sc" | "ruleId" | "top";
  readonly count: number;
  readonly patterns: readonly CorpusPattern[];
  readonly baseline: readonly BaselineRuleInfo[];
}

/**
 * `get_a11y_rules`: surface the distilled corpus patterns (`corpusPatterns`),
 * filtered by a component substring, a WCAG SC, or an axe ruleId if given, else
 * the top N by frequency tier. Lets an agent ask "what are the a11y rules for a
 * button?" BEFORE writing it. The distilled patterns are the primary result;
 * the baseline catalog backs it so a query the corpus has never distilled (e.g.
 * "color-contrast") still returns axe's standard severity + fix + helpUrl. Pure
 * read over the corpus + baseline — no disk, no scan.
 */
export function getA11yRules(filter: {
  component?: string;
  sc?: string;
  ruleId?: string;
}): GetA11yRulesResult {
  const all = corpusPatterns();

  // ruleId is an axe-specific key — the corpus distills by SC/component, not by
  // axe ruleId, so this query is answered purely from the baseline catalog.
  if (filter.ruleId !== undefined && filter.ruleId.trim() !== "") {
    const baseline = baselineRules({ ruleId: filter.ruleId });
    return { matchedOn: "ruleId", count: baseline.length, patterns: [], baseline };
  }

  if (filter.component !== undefined && filter.component.trim() !== "") {
    const needle = filter.component.trim().toLowerCase();
    const patterns = all.filter((p) => p.component.toLowerCase().includes(needle));
    // No distilled pattern? fall back to baseline by ruleId substring so a
    // component-name query still yields axe's standard rule (e.g. "image").
    const baseline = patterns.length === 0 ? baselineRules({ ruleId: needle }) : [];
    return { matchedOn: "component", count: patterns.length, patterns, baseline };
  }

  if (filter.sc !== undefined && filter.sc.trim() !== "") {
    const needle = filter.sc.trim();
    const patterns = all.filter((p) => p.sc === needle);
    // Always back an SC query with the baseline entry for that SC — coverage for
    // SCs the corpus has never distilled (e.g. 1.4.3 color-contrast).
    const baseline = baselineRules({ sc: needle });
    return { matchedOn: "sc", count: patterns.length, patterns, baseline };
  }

  const patterns = all.slice(0, TOP_RULES);
  return { matchedOn: "top", count: patterns.length, patterns, baseline: [] };
}

/** The `learn_a11y_rule` result mirrors the `learn` CLI command's report. */
export interface LearnA11yRuleResult {
  readonly added: boolean;
  readonly id: string;
  readonly contractPath: string;
  readonly blockPaths: readonly string[];
}

/**
 * `learn_a11y_rule`: append a team rule to `binclusive.json` `learned[]` and
 * regenerate the AGENTS.md / CLAUDE.md managed block — the SAME code path as
 * the `learn` CLI command (`learn` from `commands.ts`). `dir` defaults to the
 * client's cwd, matching how the CLI resolves an omitted positional.
 */
export async function learnA11yRule(input: {
  rule: string;
  wcag?: readonly string[];
  fix?: string;
  source?: string;
  dir?: string;
}): Promise<LearnA11yRuleResult> {
  const dir = input.dir ?? process.cwd();
  return learn(dir, {
    rule: input.rule,
    wcag: input.wcag ?? [],
    fix: input.fix ?? null,
    source: input.source ?? "mcp",
  });
}

/** Wrap any JSON-serializable result in the MCP text-content envelope. */
function jsonContent(value: unknown): { content: [{ type: "text"; text: string }] } {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

// The one model nomination, validated at the wire. Mirrors {@link ReviewCandidate}.
// Module-scoped so both `registerTools` (wire shape) and `reviewTool` (the
// handler tests drive) share the exact same field contract.
const reviewCandidateSchema = z.object({
  file: z.string().describe("Absolute path to the file the finding is in."),
  line: z.number().int().positive().describe("1-based line of the offending JSX element."),
  patternId: z
    .string()
    .describe("A patternId FROM corpusContext (closed vocabulary — others are dropped)."),
  codeQuote: z
    .string()
    .describe("Verbatim substring of the cited line (re-checked server-side)."),
  wcag: z.array(z.string()).describe("WCAG success criteria this candidate asserts."),
  confidence: z
    .enum(["high", "medium", "low"])
    .describe("Only `high` survives; medium/low are dropped."),
  message: z.string().describe("Advisory message for the surfaced finding."),
  justification: z
    .string()
    .describe(
      "Adversarial self-justification (G7): why is this real, not an FP, and why did the floor miss it?",
    ),
});

/** Register the three a11y tools on an existing server. Split out for testing. */
export function registerTools(server: McpServer): void {
  server.tool(
    "check_a11y",
    "Scan the .tsx files under a directory for accessibility violations and return each finding (file, line, jsx-a11y ruleId, WCAG SC, corpus frequency tier, and the representative fix) plus the component-coverage summary.",
    { dir: z.string().describe("Directory to scan recursively for .tsx files.") },
    async ({ dir }) => jsonContent(await checkA11y(dir)),
  );

  server.tool(
    "check_url",
    "Render a live URL in a real browser and run axe-core against the rendered DOM, returning each finding (the URL as file, axe ruleId, WCAG SC, corpus frequency tier, the representative fix, and the CSS selector of the offending node). Unlike check_a11y, this needs no source: it works on non-React, server-rendered, or otherwise source-less pages, while returning the same corpus-tiered findings.",
    { url: z.string().describe("The page URL to render and audit.") },
    async ({ url }) => jsonContent(await checkUrl(url)),
  );

  server.tool(
    "check_unity",
    "Scan a Unity project directory for accessibility violations in its serialized .prefab/.unity assets and return each finding (file, ruleId, WCAG SC, corpus frequency tier, and the representative fix). Mirrors check_a11y for the Unity ecosystem: missing accessible labels, color-only interactive state, and project-level gaps (no screen-reader support, no input rebinding), tiered against the same real-world corpus.",
    { dir: z.string().describe("Unity project directory to scan recursively for .prefab/.unity assets.") },
    async ({ dir }) => jsonContent(await checkUnity(dir)),
  );

  server.tool(
    "get_a11y_rules",
    "Return the accessibility rules relevant to a component, WCAG SC, or axe ruleId so you can apply them BEFORE writing the code. The primary result is the distilled corpus patterns (component, failure shape, fix, WCAG SC, real-audit frequency tier). It is backed by a baseline catalog from axe-core's published per-rule metadata (severity, standard fix, helpUrl — no org count), so a query the corpus has never distilled (e.g. \"color-contrast\" / SC 1.4.3) still returns axe's standard rule. With no filter, returns the most common distilled rules.",
    {
      component: z
        .string()
        .optional()
        .describe('Component substring to match, e.g. "button", "link", "form".'),
      sc: z.string().optional().describe('Exact WCAG success criterion, e.g. "2.4.4".'),
      ruleId: z
        .string()
        .optional()
        .describe('axe rule id substring, e.g. "color-contrast", "image-alt".'),
    },
    async ({ component, sc, ruleId }) => jsonContent(getA11yRules({ component, sc, ruleId })),
  );

  server.tool(
    "learn_a11y_rule",
    "Teach the project a new accessibility rule: append it to binclusive.json's learned[] and regenerate the AGENTS.md / CLAUDE.md managed block. Requires `a11y-checker init` to have run first in the target directory.",
    {
      rule: z.string().describe("The rule text, e.g. 'Label icon-only buttons with aria-label'."),
      wcag: z.array(z.string()).optional().describe("WCAG success criteria this rule covers."),
      fix: z.string().optional().describe("The representative fix for this rule."),
      source: z.string().optional().describe("Where the rule came from (review, audit, ...)."),
      dir: z
        .string()
        .optional()
        .describe("Project root holding binclusive.json. Defaults to the server's cwd."),
    },
    async ({ rule, wcag, fix, source, dir }) =>
      jsonContent(await learnA11yRule({ rule, wcag, fix, source, dir })),
  );

  server.tool(
    "review_a11y",
    "The corpus-grounded RECALL pass — a two-step tool that finds accessibility failures the static check missed, WITHOUT introducing false positives. Step 1 (retrieve): call with `{ dir }` to get the static findings, the corpus patterns you MAY flag (closed vocabulary), the per-line do-not-flag suppressor facts, and an instruction. Read those and nominate candidates. Step 2 (verify): call with `{ verify: true, files, candidates }`; the server re-runs a deterministic gate stack over your nominations and returns only the survivors, as ADVISORY findings (never gating the build). Use this AFTER check_a11y to catch what the static floor can't see.",
    reviewToolShape(reviewCandidateSchema),
    async (args) => jsonContent(await reviewTool(args)),
  );
}

/**
 * `review_a11y` handler, factored out so tests can drive both modes — and the
 * verify-mode cross-field contract — without a live transport. Parses the raw
 * args through {@link reviewArgsSchema} (which REJECTS `{ verify: true }` with
 * no `files`/`candidates`), then dispatches. Throws a Zod error with a clear
 * message on a contract violation.
 */
export async function reviewTool(
  args: unknown,
): Promise<ReviewRetrieveResult | ReviewVerifyResult> {
  return runReviewTool(parseReviewArgs(reviewCandidateSchema, args));
}

/**
 * The `review_a11y` tool's raw Zod shape. Factored out so the same field set
 * feeds both the wire registration ({@link registerTools}) and the
 * cross-field-validated {@link reviewArgsSchema} the handler parses with.
 */
function reviewToolShape(candidateSchema: z.ZodTypeAny) {
  return {
    dir: z
      .string()
      .optional()
      .describe("Retrieve mode: directory to scan for .tsx and ground the review."),
    verify: z.boolean().optional().describe("Set true with `files` + `candidates` to verify."),
    files: z
      .array(z.string())
      .optional()
      .describe("Verify mode: the files the candidates point at."),
    candidates: z
      .array(candidateSchema)
      .optional()
      .describe("Verify mode: your nominations from the retrieve step."),
  };
}

/**
 * Parse the raw `review_a11y` args through the cross-field contract. The SDK
 * validates the per-field shape at the wire, but it cannot express the verify
 * mode's CROSS-field requirement — `{ verify: true }` with no `files` would scan
 * `[]`, produce no floor findings and no abstentions, and vacuously pass the
 * G0/G4 vetoes, so an FP candidate survives. The refine below makes that a clear
 * contract error instead of a silent vacuous success (ADR 0003 — the
 * deterministic shell, not the model, decides precision).
 */
function parseReviewArgs(
  candidateSchema: z.ZodTypeAny,
  args: unknown,
): z.infer<ReturnType<typeof reviewArgsSchema>> {
  return reviewArgsSchema(candidateSchema).parse(args);
}

/** The cross-field-validated `review_a11y` schema (see {@link parseReviewArgs}). */
function reviewArgsSchema(candidateSchema: z.ZodTypeAny) {
  return z.object(reviewToolShape(candidateSchema)).superRefine((val, ctx) => {
    if (val.verify !== true) return;
    if (val.files === undefined || val.files.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["files"],
        message:
          "verify mode requires a non-empty `files` array: with no files the static floor scans nothing, so its suppressor/abstention vetoes are vacuous and false-positive candidates would survive.",
      });
    }
    if (val.candidates === undefined || val.candidates.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["candidates"],
        message: "verify mode requires a non-empty `candidates` array (nothing to verify otherwise).",
      });
    }
  });
}

/** Dispatch a validated `review_a11y` payload to the retrieve or verify path. */
async function runReviewTool(
  args: z.infer<ReturnType<typeof reviewArgsSchema>>,
): Promise<ReviewRetrieveResult | ReviewVerifyResult> {
  if (args.verify === true) {
    const input: ReviewInput = {
      verify: true,
      // Validated non-empty by `reviewArgsSchema`, so the `?? []` fallbacks are
      // dead — the shell rejected the vacuous-scan case before reaching here.
      files: args.files ?? [],
      candidates: (args.candidates ?? []) as ReviewCandidate[],
    };
    return reviewA11y(input);
  }
  return reviewA11yDir(args.dir ?? process.cwd());
}

/** Build the configured server (no transport attached). */
export function buildServer(): McpServer {
  const server = new McpServer(
    { name: "binclusive-a11y", version: "0.1.0" },
    {
      capabilities: { tools: {} },
      instructions: [
        "Binclusive accessibility checker, running locally over your own files.",
        "It wraps eslint-plugin-jsx-a11y with a real-world failure corpus (26-org dynamic-audit snapshot).",
        "check_a11y scans a directory and reports WCAG findings with corpus frequency tiers and fixes.",
        "check_url renders a live URL in a real browser and runs axe-core, reporting the same corpus-tiered findings for source-less or server-rendered pages.",
        "check_unity scans a Unity project's .prefab/.unity assets and reports the same corpus-tiered findings for the Unity ecosystem.",
        "get_a11y_rules returns the rules for a component or WCAG SC so you can apply them before writing code.",
        "learn_a11y_rule records a team rule into binclusive.json and the AGENTS.md/CLAUDE.md block.",
        "review_a11y is a two-step corpus-grounded recall pass: retrieve grounding then verify your nominations through a deterministic gate stack, surfacing advisory findings the static floor missed.",
      ].join(" "),
    },
  );
  registerTools(server);
  return server;
}

/** Start the stdio server. Entry point for `a11y-checker mcp` and the bin. */
export async function startStdioServer(): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Run when invoked directly (the `a11y-checker-mcp` bin). The `cli.ts` `mcp`
// subcommand calls `startStdioServer` instead of spawning this file.
if (import.meta.url === `file://${process.argv[1]}`) {
  startStdioServer().catch((err: unknown) => {
    console.error(err instanceof Error ? err.stack : String(err));
    process.exitCode = 1;
  });
}
