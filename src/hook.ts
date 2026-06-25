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
 * It handles two ecosystems by file extension: a `.tsx` edit runs the React scan
 * (floor + recall), and a `.prefab`/`.unity` edit runs the Unity finding-emission
 * aggregator (`collectUnityFindings`) over the enclosing project, scoped to the
 * edited asset — Unity reaches the editor surface at parity with React (#92).
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

import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { scan, type ScanResult } from "./core";
import { corpusFix, corpusTier, type CorpusTier, type EnrichedFinding, enrichAll } from "./corpus";
import { collectIntrinsicElements } from "./intrinsic-elements";
import { CERTIFIED_RECALL_PATTERN_IDS, type RetrievedPattern, retrieveSlice } from "./retrieve";
import { collectUnityFindings } from "./unity-findings";

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
const TIER_TAG: Record<CorpusTier, string> = {
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
  const tier = TIER_TAG[corpusTier(f.corpus)];
  const fix = corpusFix(f.corpus) ?? f.message;
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

/** Cap the recall self-check: a few of the highest-tier floor-missed shapes. */
const MAX_RECALL = 3;

/**
 * The ADVISORY recall whisper (Phase 1.5). Where {@link formatWhisper} reports the
 * PRECISE static floor ("fix these"), this surfaces the corpus RECALL grounding —
 * the floor-MISSED failure shapes (a `<Link>` whose text is present but generic /
 * noisy) that only a reading of the code can catch. It is deliberately framed as a
 * SELF-CHECK, not a finding: the deterministic hook cannot run the model's
 * propose→verify loop, so it hands the in-loop model the same grounding the
 * certified `review_a11y` retrieve step produces and asks it to self-review.
 *
 * OWNS its own empty-check: returns null when no shape survives dedup/cap, so the
 * caller hands it the eligible patterns directly and returns the result — one
 * empty-check, not two. Shipped only because the surfaced precision is certified +
 * enforced by `test/recall-certification.test.ts` (pooled Wilson >= 0.95, zero
 * decoy leaks).
 */
function formatRecall(
  filePath: string,
  patterns: readonly RetrievedPattern[],
  root: string,
): string | null {
  // Dedup by failure shape (several link patterns share a shape) and cap.
  const seen = new Set<string>();
  const shown: RetrievedPattern[] = [];
  for (const p of patterns) {
    if (seen.has(p.failureShape)) continue;
    seen.add(p.failureShape);
    shown.push(p);
    if (shown.length >= MAX_RECALL) break;
  }
  if (shown.length === 0) return null;

  const header =
    `Self-check ${relative(root, filePath)} (corpus, advisory — the static check ` +
    "can't verify these). Components here show these floor-missed failures in real " +
    "audits; confirm they don't apply, fix if they do:";
  const lines = shown.map((p) => `  · ${p.component}: ${p.failureShape}`);
  return [header, ...lines].join("\n");
}

/**
 * Build the recall self-check for a file from an EXISTING scan result. PURE over
 * the scan: it reuses `scan().resolved.resolutions` + `scan().findings` for the
 * retrieve slice (R1/R2/R3) and, for R4, the SourceFile `scan()` ALREADY parsed
 * (`resolved.sourceFiles`) — so it never re-reads or re-parses the file on this
 * every-edit hot path (no `readFileSync`/`ts.createSourceFile` here).
 *
 * No file-wide suppressed-line list: that list was file-wide (not anchored to the
 * link patterns it accompanied), cost a SECOND parse on the every-edit hot path
 * (a TOCTOU race against the editor's in-flight write), and the model already
 * reads the actual file in its propose→verify loop. The SC-disjoint filter below
 * plus that reading cover precision for this advisory surface.
 *
 * Fail-safe: any error → null (the floor whisper still stands). Returns null when
 * the file grounds no eligible pattern (the common case — nothing to self-check).
 */
function recallWhisper(filePath: string, result: ScanResult, root: string): string | null {
  try {
    // R4 — reuse scan's parse for this file (no hot-path re-parse). Absent only
    // if the file couldn't be read, in which case R4 simply contributes nothing.
    const sf = result.resolved.sourceFiles.get(filePath);
    const intrinsics = sf === undefined ? [] : collectIntrinsicElements(sf);
    const slice = retrieveSlice({
      files: [filePath],
      resolutions: result.resolved.resolutions,
      findings: result.findings,
      intrinsics,
    });
    // SC-disjoint: drop any pattern whose SC the floor ALREADY carries, so the
    // advisory only surfaces SCs the floor was SILENT on. The floor block and this
    // block become disjoint by SC — no same-SC double-up.
    const floorScs = new Set(result.findings.flatMap((f) => f.wcag));
    // Eligible AND certified AND floor-silent: tier-eligibility alone admits
    // patterns R1 pulls via a shared token (a keyboard pattern on a plain `<Link>`);
    // the advisory must only surface what we've measured, so it never points the
    // model at an unmeasured shape.
    const eligible = slice.patterns.filter(
      (p) => p.eligibleToFlag && CERTIFIED_RECALL_PATTERN_IDS.has(p.id) && !floorScs.has(p.sc),
    );

    return formatRecall(filePath, eligible, root);
  } catch {
    return null;
  }
}

/** Markers of a Unity project root, checked walking up from an edited asset.
 * `Assets` + `ProjectSettings` are the two canonical top-level dirs Unity creates;
 * either one present is enough to call a directory the project root. */
const UNITY_ROOT_MARKERS = ["Assets", "ProjectSettings"] as const;

/**
 * Locate the enclosing Unity project for an edited `.prefab`/`.unity` asset.
 * Walks up from the asset's directory looking for a Unity root marker
 * (`Assets`/`ProjectSettings`); returns the first directory that has one. Falls
 * back to the asset's own directory when no marker is found (a loose fixture or a
 * detached asset) so the aggregator still scans something rather than no-op'ing —
 * `collectUnityFindings` is forgiving, so a directory with no further assets just
 * yields the findings for this one file's siblings.
 */
function findUnityProjectRoot(filePath: string): string {
  let dir = dirname(filePath);
  for (;;) {
    if (UNITY_ROOT_MARKERS.some((m) => existsSync(join(dir, m)))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break; // reached the filesystem root
    dir = parent;
  }
  return dirname(filePath);
}

/**
 * The Unity branch of {@link runHook}: an edited `.prefab`/`.unity` asset. Locate
 * the enclosing project, run the Unity finding-emission aggregator over it
 * (`collectUnityFindings` — the SAME spine the CLI/MCP use), enrich the findings,
 * and emit the SAME floor whisper as the `.tsx` path, scoped to the edited asset so
 * the model fixes the file it just touched (per-file parity with React). No
 * Unity-specific report path — it reuses `enrichAll` + `formatWhisper` verbatim.
 *
 * Fail-safe like the `.tsx` branch: any throw → null (the edit is advisory-only).
 */
async function runUnityHook(filePath: string, base: string): Promise<HookOutput | null> {
  try {
    const projectRoot = findUnityProjectRoot(filePath);
    const raw = await collectUnityFindings(projectRoot);
    // Scope to the asset just edited (the aggregator scans the whole project) so the
    // whisper speaks only to the file the model touched — per-file parity with .tsx.
    const forFile = raw.filter((f) => resolve(f.file) === resolve(filePath));
    const findings = enrichAll(forFile);

    const floor = formatWhisper(filePath, findings, base);
    if (floor === null) return null;
    return { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: floor } };
  } catch {
    return null;
  }
}

/**
 * Run the checker on ONE edited file and return the `additionalContext`
 * envelope, or null to no-op. Pulls `file_path` from `tool_input`, resolves it
 * against `cwd` if relative, and dispatches by extension: `.tsx` runs the React
 * scan (floor + recall), `.prefab`/`.unity` runs the Unity aggregator; anything
 * else no-ops.
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

  // Unity assets take the aggregator path; .tsx takes the React scan below.
  if (filePath.endsWith(".prefab") || filePath.endsWith(".unity")) {
    return runUnityHook(filePath, base);
  }

  // Only .tsx files are scannable on the React path — silently no-op on the rest.
  if (!filePath.endsWith(".tsx")) return null;

  // FAIL-SAFE (module contract): from the scan onward, any throw → null. This
  // wraps the direct (test/non-CLI) callers too, not just `runHookCli`.
  try {
    const result = await scan([filePath]);
    const findings = enrichAll(result.findings);

    // Relativize against the file's directory so the whisper shows a short path,
    // not the absolute one ESLint reports.
    const root = base;
    // Two distinct voices: the PRECISE static floor ("fix these") and the ADVISORY
    // corpus self-check ("the static check can't verify these — confirm/fix"). Either
    // may be empty; emit nothing only when BOTH are.
    const floor = formatWhisper(filePath, findings, root);
    const recall = recallWhisper(filePath, result, root);
    if (floor === null && recall === null) return null;
    const additionalContext = [floor, recall].filter((b): b is string => b !== null).join("\n\n");

    return {
      hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext },
    };
  } catch {
    return null;
  }
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
