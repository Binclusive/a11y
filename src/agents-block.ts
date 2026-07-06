/**
 * The AGENTS.md / CLAUDE.md managed-block generator — one-way from
 * `binclusive.json`.
 *
 * The block is delimited by BEGIN/END markers and is the ONLY region the
 * checker owns in those files: everything outside the markers is preserved
 * byte-for-byte. Never hand-maintain both halves — regenerate from the
 * contract (`gen`), and CI guards drift with `gen --check`.
 *
 * Content is terse, imperative, and carries only NON-INFERABLE signal: the
 * repo's stack, its enforcement policy, and any team-learned rules. Generic
 * advice ("use semantic HTML") is deliberately excluded — an AI tool can infer
 * that. (Frequency framing left with the corpus — ADR 0041 §G.)
 */

import type { Contract, Stack } from "./contract";

export const BLOCK_BEGIN = "<!-- BEGIN binclusive (generated — edit binclusive.json, not here) -->";
export const BLOCK_END = "<!-- END binclusive -->";

/**
 * Derive a slug id from free rule text: lowercase, non-alphanumerics to
 * hyphens, collapsed and trimmed, capped so ids stay readable. Deterministic
 * (no counter, no clock) so the same rule text always yields the same id —
 * that's what makes `learn` dedupe and the block diff stable.
 */
export function slugify(text: string): string {
  const base = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return base === "" ? "rule" : base;
}

/** One-line stack header, e.g. `next (app router) · @b8e/design · ts`. */
function stackHeader(stack: Stack): string {
  const router = stack.router === null ? "" : ` (${stack.router} router)`;
  return `Stack: ${stack.framework}${router} · ${stack.designSystem} · ${stack.language}`;
}

/**
 * Render the team's learned rules. Each line leads with the SC mapping (if
 * any) and trails with the specific fix and source — a terse, non-inferable
 * shape.
 */
function learnedLines(contract: Contract): string[] {
  return contract.learned.map((r) => {
    const sc = r.wcag.length > 0 ? `SC ${r.wcag.join(", ")}` : "no SC";
    const fix = r.fix === null ? "" : ` Fix: ${r.fix}`;
    return `- [${sc} · learned · ${r.source}] ${r.rule}${fix}`;
  });
}

/**
 * The ROBOT MODE protocol — how an agent should drive the MCP tools to remediate
 * a11y. Deliberately NON-inferable (which tools, re-scan to verify): an AI can't
 * guess the tool names, so this carries real signal. Emitted at the top of every
 * generated block, so ANY
 * agent that reads AGENTS.md/CLAUDE.md — Cursor, Copilot, Codex, Windsurf, Cline —
 * runs the same loop as the Claude Code `grind` skill, with no file to copy by
 * hand. Lines stay terse and single-blank-separated (the block is re-read every
 * turn, and the splice tests forbid blank-line accumulation).
 */
const PROTOCOL_LINES: readonly string[] = [
  "Use the local `binclusive-a11y` MCP tools — `check_a11y`, `get_a11y_rules` —",
  "whenever accessibility is in scope. Don't guess from generic a11y knowledge.",
  "",
  "To fix or clean up accessibility:",
  "1. `check_a11y` the directory; work findings by severity — blocking first.",
  "2. Apply mechanical fixes (missing `type`, role typo, `href`, `tabIndex`).",
  "3. For semantic fixes (alt text, `aria-label`, link text, labels) derive a real",
  '   value from context — never filler like `alt="image"`; flag low-confidence ones.',
  "4. Re-scan after each change: a fix counts only when the checker agrees it cleared.",
  "5. Stop after 2 failed tries on a finding; report opaque `coverage` as blind spots.",
  "Remediate findings — never claim compliance. Before adding components, check",
  "`get_a11y_rules({ component })` and apply the rules first.",
];

/**
 * Build the managed block body (between, not including, the markers) from the
 * contract. Pure function of its inputs — same inputs, same bytes — which is
 * what makes regeneration idempotent and `--check` meaningful.
 */
export function renderBlock(contract: Contract): string {
  const enforcement = contract.enforcement;
  const lines: string[] = [
    BLOCK_BEGIN,
    "## Accessibility (Binclusive)",
    "",
    ...PROTOCOL_LINES,
    "",
    "### Contract",
    "",
    stackHeader(contract.stack),
    `Enforcement — block: ${enforcement.block.join(", ") || "(none)"} · warn: ${
      enforcement.warn.join(", ") || "(none)"
    }`,
  ];

  const learned = learnedLines(contract);
  if (learned.length > 0) {
    lines.push("", "### Learned (this repo)", ...learned);
  }

  lines.push(BLOCK_END);
  return lines.join("\n");
}

/**
 * Splice the freshly-rendered block into existing file content, preserving
 * everything outside the markers. Three cases:
 *
 *   - markers present : replace exactly the marked region (idempotent).
 *   - file has content but no markers : append the block after a blank line.
 *   - file empty/absent (`existing === null`) : the block IS the file.
 *
 * The result always ends with a single trailing newline. Re-splicing the
 * output of a previous splice yields byte-identical content — the property the
 * idempotence test pins.
 */
export function spliceBlock(existing: string | null, block: string): string {
  const withNewline = (s: string): string => (s.endsWith("\n") ? s : `${s}\n`);

  if (existing === null || existing.trim() === "") {
    return withNewline(block);
  }

  const begin = existing.indexOf(BLOCK_BEGIN);
  const end = existing.indexOf(BLOCK_END);
  if (begin !== -1 && end !== -1 && end > begin) {
    const before = existing.slice(0, begin);
    const after = existing.slice(end + BLOCK_END.length);
    // Trim a stray newline immediately around the old block so the rebuilt
    // content doesn't accumulate blank lines on repeated regeneration.
    const head = before.replace(/\n*$/, "");
    const tail = after.replace(/^\n*/, "");
    const parts = [head, block, tail].filter((p) => p !== "");
    return withNewline(parts.join("\n\n"));
  }

  // No managed block yet — append after existing content.
  return withNewline(`${existing.replace(/\n*$/, "")}\n\n${block}`);
}

/**
 * Extract just the managed block (markers inclusive) from file content, or
 * `null` when no block is present. Used by `gen --check` to compare the
 * on-disk block against a freshly-rendered one without diffing the whole file.
 */
export function extractBlock(content: string): string | null {
  const begin = content.indexOf(BLOCK_BEGIN);
  const end = content.indexOf(BLOCK_END);
  if (begin === -1 || end === -1 || end < begin) return null;
  return content.slice(begin, end + BLOCK_END.length);
}
