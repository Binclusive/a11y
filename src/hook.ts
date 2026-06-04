/**
 * The Claude Code "auto-whisper" hook: a `PostToolUse` handler that runs the
 * a11y-checker on JUST the file the AI just edited and feeds any findings back
 * as `additionalContext` so the model fixes them in the SAME turn.
 *
 * It is the loop-closer for slice 2. Slice 1 (`mcp.ts`) lets an agent ASK the
 * checker; this hook makes the checker speak up UNASKED the instant a `.tsx`
 * edit lands. Same wrapping discipline as `mcp.ts`: every handler is a THIN
 * wrapper over `scan` + `enrichAll` — no new a11y logic lives here.
 *
 * Contract (verified against https://docs.claude.com/en/docs/claude-code/hooks):
 *   stdin  — the PostToolUse event JSON. Relevant fields:
 *              { tool_name, tool_input: { file_path, ... }, cwd, ... }
 *            Edit / Write / MultiEdit all carry the edited path at
 *            `tool_input.file_path`.
 *   stdout — to inject context the model reads alongside the tool result:
 *              { "hookSpecificOutput":
 *                  { "hookEventName": "PostToolUse", "additionalContext": "…" } }
 *
 * Two hard rules, both because this runs in the developer's edit path:
 *   - FAST: scan ONE file, never a directory walk.
 *   - FAIL-SAFE: never throw, never block. PostToolUse cannot block the edit
 *     (it already ran), and a crash here would spam stderr to the model every
 *     edit. Any problem → emit nothing, exit 0. The edit is advisory-only.
 */

import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import { scan } from "./core";
import { type EnrichedFinding, enrichAll } from "./corpus";

/**
 * The slice of the PostToolUse payload we use. The full event carries more
 * (session_id, transcript_path, permission_mode, tool_response, …) but we only
 * need the edited path and the cwd to resolve it. `tool_input.file_path` is
 * how Edit / Write / MultiEdit each name the file they touched; `.passthrough()`
 * keeps the parse from rejecting the fields we don't model.
 *
 * `cwd` is optional: a relative `file_path` is resolved against it, but an
 * absolute path (the common case) needs neither, so a payload without `cwd`
 * still works rather than failing the parse.
 */
const PostToolUseInput = z
  .object({
    tool_name: z.string().optional(),
    cwd: z.string().optional(),
    tool_input: z.object({ file_path: z.string() }).passthrough().optional(),
  })
  .passthrough();

/** The stdout envelope that injects context back into the model. */
export interface HookOutput {
  readonly hookSpecificOutput: {
    readonly hookEventName: "PostToolUse";
    readonly additionalContext: string;
  };
}

/** Short tier tags — terser than the CLI's full labels (it runs every edit). */
const TIER_TAG: Record<EnrichedFinding["corpus"]["tier"], string> = {
  "very-common": "very-common",
  common: "common",
  occasional: "occasional",
  unknown: "unknown",
};

/** Cap the whisper: a few lines max, top findings only. It runs every edit. */
const MAX_FINDINGS = 5;

/**
 * One finding → one terse line: `file:line · rule · WCAG SC · [tier] · fix`.
 * The rule id is stripped of its `jsx-a11y/` prefix; the fix falls back to the
 * eslint message when the corpus has no representative fix for the SC.
 */
function formatLine(f: EnrichedFinding, root: string): string {
  const where = `${relative(root, f.file)}:${f.line}`;
  const rule = f.ruleId.replace(/^jsx-a11y\//, "");
  const sc = f.wcag.length > 0 ? `WCAG ${f.wcag.join(", ")}` : "no WCAG mapping";
  const tier = TIER_TAG[f.corpus.tier];
  const fix = f.corpus.fix ?? f.message;
  return `  ${where} · ${rule} · ${sc} · [${tier}] · ${fix}`;
}

/**
 * Build the `additionalContext` string for a file's findings, framed
 * imperatively so the model corrects the edit it just made. Returns null when
 * there is nothing to say (no findings) — the caller then no-ops.
 */
export function formatWhisper(
  filePath: string,
  findings: readonly EnrichedFinding[],
  root: string,
): string | null {
  if (findings.length === 0) return null;
  const shown = findings.slice(0, MAX_FINDINGS);
  const header = `You just edited ${relative(root, filePath)}. It has these accessibility issues — fix them now:`;
  const lines = shown.map((f) => formatLine(f, root));
  const more =
    findings.length > shown.length
      ? [`  …and ${findings.length - shown.length} more (run \`a11y-checker check\` for all).`]
      : [];
  return [header, ...lines, ...more].join("\n");
}

/**
 * Run the checker on ONE edited file and return the `additionalContext`
 * envelope, or null to no-op. Pulls `file_path` from `tool_input`, resolves it
 * against `cwd` if relative, and skips anything that isn't a `.tsx`.
 *
 * Reused by both the CLI entry and the tests — the tests call it directly with
 * a sample payload, the CLI feeds it parsed stdin.
 */
export async function runHook(raw: unknown): Promise<HookOutput | null> {
  const parsed = PostToolUseInput.safeParse(raw);
  if (!parsed.success) return null;

  const filePathRaw = parsed.data.tool_input?.file_path;
  if (filePathRaw === undefined) return null;

  // Resolve relative paths against the event's cwd; absolute paths pass through.
  const base = parsed.data.cwd ?? process.cwd();
  const filePath = isAbsolute(filePathRaw) ? filePathRaw : resolve(base, filePathRaw);

  // Only .tsx files are scannable — silently no-op on everything else.
  if (!filePath.endsWith(".tsx")) return null;

  const result = await scan([filePath]);
  const findings = enrichAll(result.findings);

  // Relativize against the file's directory so the whisper shows a short path,
  // not the absolute one ESLint reports.
  const root = base;
  const additionalContext = formatWhisper(filePath, findings, root);
  if (additionalContext === null) return null;

  return {
    hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext },
  };
}

/** Read all of stdin to a string. Returns "" if stdin is empty/closed. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * CLI entry for `a11y-checker hook`: read the PostToolUse JSON from stdin, run
 * the checker on the edited file, and print the `additionalContext` envelope.
 *
 * Wrapped end-to-end so NOTHING escapes as a non-zero exit or an unhandled
 * throw — a hook that crashes would heckle the model on every edit. On any
 * problem (bad JSON, scan failure, non-tsx) it prints nothing and exits 0.
 */
export async function runHookCli(): Promise<void> {
  try {
    const stdin = await readStdin();
    if (stdin.trim() === "") return;

    let raw: unknown;
    try {
      raw = JSON.parse(stdin);
    } catch {
      return; // malformed input → no-op
    }

    const output = await runHook(raw);
    if (output !== null) {
      process.stdout.write(JSON.stringify(output));
    }
  } catch {
    // Fail-safe: any error → silent no-op, exit 0. Never block the edit.
  }
}
