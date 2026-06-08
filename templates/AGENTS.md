# Accessibility — ROBOT MODE (Binclusive)

Template `AGENTS.md` for a **customer repo**. Drop it at the repo root (or run
`a11y-checker init`, which will splice its rules block in below). Any agent that
reads `AGENTS.md` — Cursor, GitHub Copilot, Codex, Windsurf, Cline — then runs the
same ROBOT MODE loop as the Claude Code `grind` skill.

---

This project uses the local `binclusive-a11y` MCP server — tools `check_a11y`,
`get_a11y_rules`, `learn_a11y_rule`. It scans React/TSX for accessibility
violations against a real-world audit corpus, entirely on this machine — no
upload. When accessibility is in scope, **use these tools**; do not guess from
generic a11y knowledge.

## When asked to fix / clean up / "grind" accessibility

Loop until the checker is clean:

1. **Scan** — call `check_a11y({ dir })`. You get findings (`file`, `line`,
   `ruleId`, `wcag`, `tier`, `fix`, `message`, `provenance`) and a `coverage`
   summary.
2. **Rank by `tier`** — fix `very-common` → `common` → `occasional`. Real auditors
   flag the common shapes first; so do you. Even a partial run then covers what
   matters most.
3. **Apply vs propose, by confidence:**
   - *Mechanical* (deterministic: missing `type`, role typo, `tabIndex` misuse,
     missing `href`) → apply the fix.
   - *Semantic* (needs meaning: `alt` text, `aria-label`, link text, label↔control
     association) → derive a real value from surrounding context and flag it
     `⚠ needs-review`.
4. **Never write filler.** No `alt="image"`, no `aria-label="button"`. A fix that
   satisfies the rule while lying to a screen-reader user is worse than leaving the
   finding open — list it for a human instead.
5. **Re-scan after each file** — a fix counts only when `check_a11y` agrees it
   cleared and introduced no new finding.
6. **Stop** when findings are empty, or after 2 failed attempts on one finding.
   Report `coverage` opaque components as blind spots (`a11y-checker init` declares
   them). Never claim compliance — you remediate findings, you do not certify.

## Before writing new components

Call `get_a11y_rules({ component })` and apply the corpus rules up front — cheaper
than fixing after.

<!-- a11y-checker manages a corpus-rules block below this line; `a11y-checker init`
     and `learn` regenerate it. Everything OUTSIDE the markers (the protocol above)
     is preserved across regenerations. -->
