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
import { VERSION } from "./version";
import {
  type BaselineRuleInfo,
  baselineRules,
  type AxeImpact,
  evidenceBestPractice,
  type Evidence,
  evidenceHelpUrl,
  evidenceImpact,
  type EnrichedFinding,
  enrichAll,
  resolveDisplay,
} from "./evidence";
import type { Coverage } from "./resolve-components";
import { collectUnityFindings } from "./unity-findings";

/** A single finding flattened to the shape the MCP tool returns. */
export interface CheckFinding {
  readonly file: string;
  readonly line: number;
  readonly ruleId: string;
  readonly wcag: readonly string[];
  /**
   * Which evidence source matched: `baseline` (axe's published per-rule catalog —
   * coverage) or `none`. This flat shape is the deliberate FLAT VIEW of the
   * {@link Evidence} union for external API consumers — the per-source accessors
   * below project it. Frequency is no longer carried (ADR 0041 §G — the audit
   * corpus left the engine; frequency is platform-derived).
   */
  readonly source: Evidence["source"];
  /** Impact: axe runtime impact, else the baseline catalog default; null when unknown. */
  readonly impact: AxeImpact | null;
  /**
   * True for a baseline match on an axe best-practice rule with no WCAG SC — an
   * axe recommendation, not a WCAG conformance failure.
   */
  readonly bestPractice: boolean;
  /**
   * The rule-accurate fix. For source-pass findings (`jsx-a11y` / `enforce`)
   * this is the SC-keyed baseline fix. For `provenance === "axe"` findings it is
   * axe's OWN per-rule guidance (axe help), NOT the SC-generic baseline fix —
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
    impact: evidenceImpact(f),
    bestPractice: evidenceBestPractice(f.corpus),
    fix: resolveDisplay(f).fix,
    helpUrl: evidenceHelpUrl(f),
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
 * return the baseline-enriched findings plus the coverage summary. Mirrors the
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
 * enrichment pass `check_a11y` uses. The only difference is the source: a
 * rendered page instead of `.tsx` files, so `file` is the URL (kept as-is, NOT
 * relativized) and each finding carries the axe `selector`. No new a11y logic.
 */
export async function checkUrl(url: string): Promise<CheckUrlResult> {
  const result = await scanUrl(url);
  // A failed render is surfaced as a thrown error (the MCP tool handler reports it),
  // never a silent empty finding set — the same failed-vs-clean invariant #218 makes
  // explicit on the CLI. scanUrl now returns this as data; re-throw to keep the MCP
  // surface's fail-loud behavior.
  if (result.status === "failed") throw new Error(result.error);
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
 * `Finding[]`), then run those findings through `enrichAll` — the SAME baseline enrichment
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
 * The `get_a11y_rules` result. The corpus left the engine (ADR 0041 §G), so the
 * answer is now purely the coverage catalog: axe's published per-rule entries
 * (impact + standard fix + helpUrl, NO org count, NO frequency tier) for the
 * requested component/SC/ruleId, so the tool can answer for any axe/WCAG rule.
 */
export interface GetA11yRulesResult {
  readonly matchedOn: "component" | "sc" | "ruleId" | "top";
  readonly count: number;
  readonly baseline: readonly BaselineRuleInfo[];
}

/**
 * `get_a11y_rules`: surface the axe baseline catalog, filtered by a component
 * substring (matched against the axe ruleId), a WCAG SC, or an axe ruleId if
 * given, else the top N rules. Lets an agent ask "what are the a11y rules for a
 * button?" BEFORE writing it. Pure read over the baseline catalog — no disk, no
 * scan, no corpus.
 */
export function getA11yRules(filter: {
  component?: string;
  sc?: string;
  ruleId?: string;
}): GetA11yRulesResult {
  if (filter.ruleId !== undefined && filter.ruleId.trim() !== "") {
    const baseline = baselineRules({ ruleId: filter.ruleId });
    return { matchedOn: "ruleId", count: baseline.length, baseline };
  }

  if (filter.component !== undefined && filter.component.trim() !== "") {
    // A component-name query maps to a ruleId substring so it still yields axe's
    // standard rule (e.g. "image" → image-alt).
    const needle = filter.component.trim().toLowerCase();
    const baseline = baselineRules({ ruleId: needle });
    return { matchedOn: "component", count: baseline.length, baseline };
  }

  if (filter.sc !== undefined && filter.sc.trim() !== "") {
    const baseline = baselineRules({ sc: filter.sc.trim() });
    return { matchedOn: "sc", count: baseline.length, baseline };
  }

  const baseline = baselineRules().slice(0, TOP_RULES);
  return { matchedOn: "top", count: baseline.length, baseline };
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

/** Register the a11y tools on an existing server. Split out for testing. */
export function registerTools(server: McpServer): void {
  server.tool(
    "check_a11y",
    "Scan the .tsx files under a directory for accessibility violations and return each finding (file, line, jsx-a11y ruleId, WCAG SC, impact, and the representative fix) plus the component-coverage summary.",
    { dir: z.string().describe("Directory to scan recursively for .tsx files.") },
    async ({ dir }) => jsonContent(await checkA11y(dir)),
  );

  server.tool(
    "check_url",
    "Render a live URL in a real browser and run axe-core against the rendered DOM, returning each finding (the URL as file, axe ruleId, WCAG SC, impact, the representative fix, and the CSS selector of the offending node). Unlike check_a11y, this needs no source: it works on non-React, server-rendered, or otherwise source-less pages, while returning the same baseline findings.",
    { url: z.string().describe("The page URL to render and audit.") },
    async ({ url }) => jsonContent(await checkUrl(url)),
  );

  server.tool(
    "check_unity",
    "Scan a Unity project directory for accessibility violations in its serialized .prefab/.unity assets and return each finding (file, ruleId, WCAG SC, impact, and the representative fix). Mirrors check_a11y for the Unity ecosystem: missing accessible labels, color-only interactive state, and project-level gaps (no screen-reader support, no input rebinding), against the same axe baseline catalog.",
    { dir: z.string().describe("Unity project directory to scan recursively for .prefab/.unity assets.") },
    async ({ dir }) => jsonContent(await checkUnity(dir)),
  );

  server.tool(
    "get_a11y_rules",
    "Return the accessibility rules relevant to a component, WCAG SC, or axe ruleId so you can apply them BEFORE writing the code. The result is axe-core's published per-rule baseline catalog (ruleId, WCAG SC, impact, standard fix, helpUrl) for the requested component, SC, or ruleId (e.g. \"color-contrast\" / SC 1.4.3). With no filter, returns the top rules.",
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
}

/** Build the configured server (no transport attached). */
export function buildServer(): McpServer {
  const server = new McpServer(
    { name: "binclusive-a11y", version: VERSION },
    {
      capabilities: { tools: {} },
      instructions: [
        "Binclusive accessibility checker, running locally over your own files.",
        "It wraps eslint-plugin-jsx-a11y with axe-core's published per-rule baseline catalog.",
        "check_a11y scans a directory and reports WCAG findings with severities and fixes.",
        "check_url renders a live URL in a real browser and runs axe-core, reporting the same findings for source-less or server-rendered pages.",
        "check_unity scans a Unity project's .prefab/.unity assets and reports the same findings for the Unity ecosystem.",
        "get_a11y_rules returns the rules for a component or WCAG SC so you can apply them before writing code.",
        "learn_a11y_rule records a team rule into binclusive.json and the AGENTS.md/CLAUDE.md block.",
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
