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
import { learn } from "./commands";
import { scan } from "./core";
import { type CorpusPattern, corpusPatterns, type EnrichedFinding, enrichAll } from "./corpus";
import type { Coverage } from "./resolve-components";

/** A single finding flattened to the shape the MCP tool returns. */
export interface CheckFinding {
  readonly file: string;
  readonly line: number;
  readonly ruleId: string;
  readonly wcag: readonly string[];
  readonly tier: EnrichedFinding["corpus"]["tier"];
  readonly fix: string | null;
  readonly message: string;
  readonly enforcement: EnrichedFinding["enforcement"];
  /** Which pass produced it: structural `jsx-a11y`, or the call-site `enforce` check. */
  readonly provenance: EnrichedFinding["provenance"];
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

  const findings: CheckFinding[] = enriched.map((f) => ({
    file: relative(root, f.file),
    line: f.line,
    ruleId: f.ruleId,
    wcag: f.wcag,
    tier: f.corpus.tier,
    fix: f.corpus.fix,
    message: f.message,
    enforcement: f.enforcement,
    provenance: f.provenance,
  }));

  return { root, filesScanned: files.length, coverage: result.coverage, findings };
}

/** How many patterns `get_a11y_rules` returns when no filter is given. */
const TOP_RULES = 15;

/** The `get_a11y_rules` result: the matched corpus patterns and how they matched. */
export interface GetA11yRulesResult {
  readonly matchedOn: "component" | "sc" | "top";
  readonly count: number;
  readonly patterns: readonly CorpusPattern[];
}

/**
 * `get_a11y_rules`: surface the distilled corpus patterns (`corpusPatterns`),
 * filtered by a component substring or a WCAG SC if given, else the top N by
 * frequency tier. Lets an agent ask "what are the a11y rules for a button?"
 * BEFORE writing it. Pure read over the corpus — no disk, no scan.
 */
export function getA11yRules(filter: { component?: string; sc?: string }): GetA11yRulesResult {
  const all = corpusPatterns();

  if (filter.component !== undefined && filter.component.trim() !== "") {
    const needle = filter.component.trim().toLowerCase();
    const patterns = all.filter((p) => p.component.toLowerCase().includes(needle));
    return { matchedOn: "component", count: patterns.length, patterns };
  }

  if (filter.sc !== undefined && filter.sc.trim() !== "") {
    const needle = filter.sc.trim();
    const patterns = all.filter((p) => p.sc === needle);
    return { matchedOn: "sc", count: patterns.length, patterns };
  }

  const patterns = all.slice(0, TOP_RULES);
  return { matchedOn: "top", count: patterns.length, patterns };
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

/** Register the three a11y tools on an existing server. Split out for testing. */
export function registerTools(server: McpServer): void {
  server.tool(
    "check_a11y",
    "Scan the .tsx files under a directory for accessibility violations and return each finding (file, line, jsx-a11y ruleId, WCAG SC, corpus frequency tier, and the representative fix) plus the component-coverage summary.",
    { dir: z.string().describe("Directory to scan recursively for .tsx files.") },
    async ({ dir }) => jsonContent(await checkA11y(dir)),
  );

  server.tool(
    "get_a11y_rules",
    "Return the accessibility rules (distilled corpus patterns: component, failure shape, fix, WCAG SC, frequency tier) relevant to a component or WCAG SC, so you can apply them BEFORE writing the code. With no filter, returns the most common rules.",
    {
      component: z
        .string()
        .optional()
        .describe('Component substring to match, e.g. "button", "link", "form".'),
      sc: z.string().optional().describe('Exact WCAG success criterion, e.g. "2.4.4".'),
    },
    async ({ component, sc }) => jsonContent(getA11yRules({ component, sc })),
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
    { name: "binclusive-a11y", version: "0.0.0" },
    {
      capabilities: { tools: {} },
      instructions: [
        "Binclusive accessibility checker, running locally over your own files.",
        "It wraps eslint-plugin-jsx-a11y with a real-world failure corpus (26-org dynamic-audit snapshot).",
        "check_a11y scans a directory and reports WCAG findings with corpus frequency tiers and fixes.",
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
