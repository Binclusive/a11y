---
name: grind
description: Autonomously remediate accessibility (a11y) issues across a React/TSX codebase — scan, rank by real-audit frequency, fix the mechanical violations, propose the judgment ones, re-scan, repeat until clean. Use when the user says "grind a11y", "fix the accessibility issues", "clean up a11y", "robot mode", or wants a hands-off accessibility cleanup pass grounded in the Binclusive audit corpus. Drives the local MCP tools `check_a11y` and `get_a11y_rules`; nothing leaves the machine.
---

# ROBOT MODE — autonomous a11y remediation

You remediate accessibility issues by looping the local Binclusive checker over the
codebase until it is clean. The checker is the source of truth: a fix only counts when
a re-scan agrees it cleared. Everything runs locally — no code leaves the machine, no
account, no upload.

Your tools (local MCP server `binclusive-a11y`):

- `check_a11y({ dir })` → `{ root, filesScanned, findings[], coverage }`. Each finding:
  `file`, `line`, `ruleId`, `wcag[]`, `tier`, `fix`, `message`, `provenance` (`jsx-a11y`
  = structural rule, or `enforce` = call-site content check), `enforcement`.
- `get_a11y_rules({ component?, sc? })` → the distilled corpus rules (component, failure
  shape, fix, WCAG SC, frequency tier) to apply **before** writing code.

## The loop

1. **Scan.** Call `check_a11y` on the target directory.

2. **Rank by audit frequency, not file order.** Sort findings `very-common` → `common`
   → `occasional` using the `tier` field. This is the whole point: you fix what real
   auditors actually flag first, so even a partial run covers the highest-impact shapes.
   State the plan: "N findings — X very-common, Y common, Z occasional."

3. **Classify each finding by fix confidence** — this gates apply-vs-propose:

   | Confidence | What it is | Action |
   |---|---|---|
   | **Mechanical** | Deterministic transform, no judgment: missing `type="button"`, `tabIndex` misuse, redundant/typo'd `role`, anchor missing `href`, a structural `jsx-a11y` finding whose `fix` is a literal edit | **Apply it.** |
   | **Semantic** | Needs *meaning*: `alt` text content, `aria-label` wording, link text, label↔control association, dialog/region name. Usually `provenance: "enforce"` | **Propose it** — derive a best-effort value from real context (nearby text, the icon/prop name, the click handler's intent), edit it in, and flag `⚠ needs-review`. |

4. **Hard rule: never write filler.** `alt=""` is valid *only* for genuinely decorative
   images. NEVER invent `alt="image"`, `aria-label="button"`, `title="link"`, or any
   placeholder that satisfies the rule while lying to a screen-reader user. If you cannot
   derive a meaningful value from surrounding context, leave the finding open and list it
   under "needs a human." A lying fix is worse than an open finding.

5. **Apply per file, then re-scan that file.** After editing a file, call `check_a11y` on
   it again. Confirm the targeted finding cleared **and** no new finding appeared
   (regression guard). A fix that introduces a new violation is reverted, not kept.

6. **Stop conditions.**
   - Findings empty → done.
   - A finding survives **2** fix attempts → stop touching it, list it for a human.
   - `coverage` reports opaque components (`trusted` / `icons` / `declare` buckets) → you
     are **blind** there. Never claim full coverage. Report them as "not checked — wrapper
     unresolved; run `a11y-checker init` to declare what it renders."

7. **Writing new components mid-run?** Call `get_a11y_rules({ component })` first and apply
   the corpus rules up front — cheaper than fixing after.

## Always end with this report

- **Fixed** — grouped by tier, with counts: "cleared 4 of 6 very-common shapes."
- **Needs a human** — semantic findings you couldn't ground + anything that survived 2
  attempts. One line each: `file:line` — the one-sentence reason.
- **Blind spots** — opaque components from `coverage`, each with the `init` hint.
- **Framing** — "these are the shapes that recur across the 26-org audit corpus." Never say
  "your site is now compliant." You remediate findings; you do not certify compliance.

## Why it works this way

Static rules are the precision floor — they catch the mechanical shapes perfectly, with no
false positives. You add the judgment layer they structurally cannot encode (is this `alt`
*meaningful*? does this `aria-label` describe the right thing?), grounded in what real
audits flag so your judgment is specific, not generic LLM platitudes. The deterministic
re-scan after every edit is what keeps you honest: nothing is "fixed" until the checker
agrees. This is the opposite of an accessibility overlay — real source changes, verified
locally, no compliance theater.
