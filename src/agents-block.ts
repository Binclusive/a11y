/**
 * The AGENTS.md / CLAUDE.md managed-block generator — one-way from
 * `binclusive.json` + the distilled corpus.
 *
 * The block is delimited by BEGIN/END markers and is the ONLY region the
 * checker owns in those files: everything outside the markers is preserved
 * byte-for-byte. Never hand-maintain both halves — regenerate from the
 * contract (`gen`), and CI guards drift with `gen --check`.
 *
 * Content is terse, imperative, and carries only NON-INFERABLE signal: the
 * WCAG SC mapping, the corpus frequency tier, and the specific representative
 * fix. Generic advice ("use semantic HTML") is deliberately excluded — an AI
 * tool can infer that; it can't infer which SC the customer's corpus shows
 * fail most often.
 */

import type { Contract, Stack } from "./contract";
import type { CorpusPattern } from "./corpus";

export const BLOCK_BEGIN = "<!-- BEGIN binclusive (generated — edit binclusive.json, not here) -->";
export const BLOCK_END = "<!-- END binclusive -->";

/**
 * Hard cap on distilled-pattern lines in the block. The block is re-read every
 * agent turn, so over-stuffing it is the ETH-Zurich over-context trap — the
 * cap keeps the moat visible without drowning the prompt. Anything past the cap
 * is summarized as "+N more in the corpus" so it never reads as the whole set.
 */
const MAX_CORPUS_PATTERNS = 12;

const TIER_LABEL: Record<CorpusPattern["tier"], string> = {
  "very-common": "VERY COMMON",
  common: "COMMON",
  occasional: "OCCASIONAL",
  unknown: "UNKNOWN",
};

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
 * Collapse a multi-sentence corpus string (failureShape / fix) to its first
 * sentence, whitespace-normalized and length-capped, so each pattern is ONE
 * terse line. The full text lives in the distilled corpus — this is the
 * scannable signal, not the spec.
 */
function shortForm(text: string, max: number): string {
  const oneSentence =
    text
      .replace(/\s+/g, " ")
      .trim()
      .split(/(?<=[.;])\s/)[0] ?? "";
  if (oneSentence.length <= max) return oneSentence;
  return `${oneSentence.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Render the distilled corpus patterns — the real failure-shape moat, not the
 * seed snapshot. Ordered by the accessor (tier → SC → id), capped at
 * MAX_CORPUS_PATTERNS; the overflow is a single "+N more" line so the block
 * never reads as the complete set. Each line carries the pattern's component,
 * a one-sentence shape→fix, and its SC + tier + aggregate org count (the
 * non-inferable signal). The aggregate "X/26 orgs" comes from the SC snapshot;
 * the per-shape text comes from the distilled patterns.
 */
function corpusLines(patterns: readonly CorpusPattern[]): string[] {
  const shown = patterns.slice(0, MAX_CORPUS_PATTERNS);
  const lines = shown.map((p) => {
    const orgs = p.orgs === null ? "" : ` · ${p.orgs}/26 orgs`;
    const tag = `SC ${p.sc} · ${TIER_LABEL[p.tier]}${orgs}`;
    const shape = shortForm(p.failureShape, 90);
    const fix = shortForm(p.fix, 90);
    return `- [${tag}] ${p.component}: ${shape} → ${fix}`;
  });
  const overflow = patterns.length - shown.length;
  if (overflow > 0) {
    lines.push(`- +${overflow} more in the corpus (run \`a11y-checker check\` for the full set)`);
  }
  return lines;
}

/**
 * Render the team's learned rules. Each line leads with the SC mapping (if
 * any) and trails with the specific fix and source — the same terse,
 * non-inferable shape as the corpus lines.
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
 * a11y. Deliberately NON-inferable (which tools, rank by `tier`, re-scan to
 * verify): an AI can't guess the tool names or the corpus-frequency ordering, so
 * this carries real signal. Emitted at the top of every generated block, so ANY
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
  "1. `check_a11y` the directory; work findings by `tier` — very-common first.",
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
 * contract and the distilled corpus patterns. Pure function of its inputs —
 * same inputs, same bytes — which is what makes regeneration idempotent and
 * `--check` meaningful.
 */
export function renderBlock(contract: Contract, patterns: readonly CorpusPattern[]): string {
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
    "",
    "Honor these rules. Each carries its WCAG SC and how widespread the failure is",
    "across Binclusive's audit corpus — lead fixes with the most widespread.",
    "",
    "### Corpus patterns (most frequent first)",
    ...corpusLines(patterns),
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
