# Getting Started

Zero to your first accessibility fix. This is the literal first-run experience:
what you install, what you type, what you'll **see**, and what to do next at each
step. Everything runs on your machine — no account, no upload, your code never
leaves the laptop.

The walkthrough below is a real run against a real app: a Next.js (app-router) +
Radix + Tailwind codebase, 174 `.tsx` files. Every output block is captured from
an actual run, not invented.

> **TL;DR for the impatient:** the package is `@binclusive/a11y`, distributed
> **privately** via GitHub Packages — you authenticate once (step 1), then it's
> two commands in your agent (step 2). The CLI is one `npx @binclusive/a11y …`
> away the moment auth resolves.

---

## 1. Install

**Why:** the checker ships as a private npm package plus a Claude Code plugin
that bundles three surfaces — an MCP server, an auto-whisper hook, and a `grind`
skill. It is **not** on public npm, so there's a one-time auth step before
anything resolves.

### 1a. Authenticate to the private registry (one time, required)

You need a GitHub account with **read access to the `@binclusive` packages** —
ask your Binclusive contact to grant it. Then create a GitHub **Personal Access
Token (classic)** with the **`read:packages`** scope and add it to `~/.npmrc`:

```ini
@binclusive:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=YOUR_GITHUB_TOKEN
```

Verify it resolves before going further:

```bash
npm view @binclusive/a11y version   # prints a version, not 401/404
```

> If this prints `401`/`404`, the token is missing the `read:packages` scope or
> your account hasn't been granted access yet. Fix this first — every command
> below resolves the package through this registry.

### 1b. Install the plugin (Claude Code)

```text
/plugin marketplace add Binclusive/a11y
/plugin install a11y-checker@binclusive
```

One install registers, together:

- the local **MCP server** — `check_a11y`, `check_url`, `get_a11y_rules`, `learn_a11y_rule`;
- the **auto-whisper hook** — flags a11y the instant the agent edits a `.tsx` file;
- the **`grind` skill** — ROBOT MODE (autonomous remediation).

**Not on Claude Code?** Cursor, Copilot, Codex, Windsurf, and Cline read the
vendor-neutral MCP server and the generated `AGENTS.md` — see
[step 3](#3-wire-your-editor) and [INSTALL.md](INSTALL.md).

**What to do next:** `cd` into the repo you want to check, then run `init`.

---

## 2. `init` — detect your stack, write the contract

**Why:** `init` reads your repo, figures out the stack (framework, router, design
system, language), and writes two things: `binclusive.json` (the committed
contract) and a managed block inside `AGENTS.md` + `CLAUDE.md` so your agent
carries the corpus rules into every turn.

```bash
npx @binclusive/a11y init        # run in your project root
```

**What you'll see:**

```
a11y-checker init — /path/to/your-app
  stack:       next (app router) · Radix · ts
  enforcement: block 1.3.1, 4.1.2, 2.4.4
  wrote:       binclusive.json
  block:       AGENTS.md
  block:       CLAUDE.md
```

It detected Next with the app router, a Radix design system, and TypeScript —
all from disk, no flags. The `block` list (1.3.1, 4.1.2, 2.4.4) is the set of
WCAG criteria that will **fail a build**; everything else is a warning.

`binclusive.json` is the source of truth — commit it:

```json
{
  "version": 1,
  "stack": {
    "framework": "next",
    "router": "app",
    "designSystem": "Radix",
    "language": "ts"
  },
  "enforcement": {
    "block": ["1.3.1", "4.1.2", "2.4.4"],
    "warn": ["1.1.1", "2.1.1", "3.3.2", "2.4.1", "2.4.3", "4.1.3", "3.3.1"]
  },
  "learned": []
}
```

And the managed block written into `CLAUDE.md` / `AGENTS.md` carries the corpus
rules your agent should honor — the most widespread failures first:

```
<!-- BEGIN binclusive (generated — edit binclusive.json, not here) -->
## Accessibility (Binclusive)

Use the local `binclusive-a11y` MCP tools — `check_a11y`, `get_a11y_rules` —
whenever accessibility is in scope. Don't guess from generic a11y knowledge.
...
### Corpus patterns (most frequent first)
- [SC 1.3.1 · VERY COMMON · 22/26 orgs] form input: A form input ... has no programmatically associated label → Associate every input with a real label ...
- [SC 1.1.1 · COMMON · 16/26 orgs] informative image: ... a filename, technical id, or generic placeholder → Write alt text that conveys the image's meaning ...
- +39 more in the corpus (run `a11y-checker check` for the full set)
<!-- END binclusive -->
```

> **Re-running is safe.** `init` only refreshes the auto-detected `stack`. Your
> `learned[]` rules, `enforcement` policy, and any manual `declarations` are
> preserved byte-for-byte. Edit `binclusive.json`, never the generated block.

> **Using your own design system?** A cold scan leaves most of your components
> in the `declare` bucket — that's expected (see step 4). Run
> `npx @binclusive/a11y init --suggest` to scaffold the `components` map: it
> guesses a host (`button`/`input`/…) for each unresolved primitive for you to
> review before committing.

**What to do next:** wire your editor so findings come back as you code.

---

## 3. Wire your editor

**Why:** with the MCP server connected, your agent can *ask* the checker
(`check_a11y`, `check_url`, `get_a11y_rules`, `learn_a11y_rule`); with the hook
wired, the checker *speaks up unasked* the instant the agent edits a `.tsx` file.
On Claude Code, the plugin install in step 1 already did both. For any other
agent, add the two pieces by hand.

**MCP server** — add to your tool's `.mcp.json` (stdio). This is the exact snippet
the plugin uses:

```json
{
  "mcpServers": {
    "binclusive-a11y": {
      "command": "npx",
      "args": ["-y", "@binclusive/a11y", "mcp"]
    }
  }
}
```

That gives Cursor / Copilot / Codex / Windsurf / Cline the four tools:
`check_a11y` (scan source), `check_url` (render a live page), `get_a11y_rules`
(rules for a component/SC, to apply *before* writing code), and
`learn_a11y_rule` (record a team rule).

**Auto-whisper hook** — the PostToolUse hook scans *just the file the AI just
edited* and feeds findings back as context so the model fixes them in the same
turn. The plugin wires it via this hook config:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit",
        "hooks": [
          { "type": "command", "command": "npx", "args": ["-y", "@binclusive/a11y", "hook"] }
        ]
      }
    ]
  }
}
```

It's fast (one file, never a directory walk) and fail-safe (never blocks an
edit — findings are advisory).

**What to do next:** run a full check to see where you stand.

---

## 4. First check — and how to read a finding

**Why:** `check` scans every `.tsx` under a directory and reports a coverage
summary plus every finding, ranked by how widespread the failure is across
Binclusive's real-world audit corpus.

```bash
npx @binclusive/a11y check .
```

**What you'll see** — first the coverage report:

```
a11y-checker — scanned 174 .tsx file(s) under /path/to/your-app

a11y coverage:
  checked  27   — elements we inspected (findings come from here)
  trusted  51   — from a known-accessible design system (Radix) — the library handles these
  declare  105  — unrecognized; declare in binclusive.json to inspect them:
    Tabs (from @/components/ui/tabs) — unrecognized. Declare it: binclusive.json → "components": { "Tabs": "button|a|input|textarea|select|label|div" }
    ...
```

Read the coverage line by line:

- **`checked`** — components we resolved to real host elements and inspected.
  *Every finding comes from here.*
- **`trusted`** — opaque components from a known-accessible library (Radix). The
  library guarantees their structure, so opaque is fine. The content *you* pass
  them (labels, alt) is still checked by the call-site content check.
- **`declare`** — opaque components we *don't* recognize. This is the real gap,
  and the only actionable bucket: each line is a copy-paste config to-do for
  `binclusive.json`. A high `declare` count on a cold scan is **expected, not a
  failure** — declaring your primitives (or `init --suggest`) turns the checker's
  best trick on.

Then the findings. Here's a real one — read it top to bottom:

```
app/easy-mvp-pricing/page.tsx:333
  rule:   jsx-a11y/anchor-is-valid  [block]
  wcag:   WCAG 2.4.4
  The href attribute requires a valid value to be accessible. ...
  severity: CRITICAL
  corpus: [VERY COMMON] SC 2.4.4 — 17/26 orgs
  fix:    Give links discernible text or an aria-label that identifies the destination; ...
  seen-in-the-wild (distilled, SC 2.4.4):
    • [COMMON] non-descriptive link — "click here", "more info", "read more" ...
    • [COMMON] icon / image / empty link — a link wraps only an icon or SVG ...
```

| Line | What it tells you |
|---|---|
| `app/easy-mvp-pricing/page.tsx:333` | **Location** — exact file and line. |
| `rule: jsx-a11y/anchor-is-valid [block]` | The rule that fired, and that it **blocks** a build (per your contract). |
| `wcag: WCAG 2.4.4` | The **WCAG success criterion** it maps to. |
| `corpus: [VERY COMMON] SC 2.4.4 — 17/26 orgs` | The **corpus tier**: this failure appeared in **17 of 26** audited orgs. Fix the very-common ones first. |
| `fix: …` | The representative fix that worked in the corpus. |
| `seen-in-the-wild` | The distilled failure shapes for this SC — the concrete variants real auditors flag. |

The run ends with a rollup and the gate:

```
57 finding(s)   COMMON: 1  |  VERY COMMON: 56
enforcement: 56 blocking · 1 warning
```

> **About the exit code:** `check` exits **non-zero** when it finds blocking
> issues — by design, so it can gate CI (step 8). Exit `1` is not a crash; it
> means it found something. Read the report above it.

**What to do next:** clear one finding and watch the count drop.

---

## 5. Fix one — and watch it clear

**Why:** the loop that makes the tool trustworthy is *fix → re-scan → confirm
cleared*. A fix only counts when the checker agrees.

Take a real finding from the run above — an icon-only Twitter button with no
accessible name in `components/ShareButtons.tsx`:

```tsx
// before — flagged: enforce/button-no-name [block], SC 1.3.1 — 22/26 orgs
<Button variant="outline" size="icon" onClick={handleProfileVisit}>
  <Twitter className="h-4 w-4" />
</Button>
```

Apply the corpus fix — give the control a real accessible name (never filler;
`aria-label="button"` is a lie to a screen-reader user):

```tsx
// after
<Button variant="outline" size="icon" aria-label="Visit our Twitter profile" onClick={handleProfileVisit}>
  <Twitter className="h-4 w-4" />
</Button>
```

Re-run the check:

```bash
npx @binclusive/a11y check .
```

**What you'll see** — the count dropped and `ShareButtons.tsx` is gone:

```
# before the fix:
57 finding(s)   COMMON: 1  |  VERY COMMON: 56

# after the fix:
56 finding(s)   COMMON: 1  |  VERY COMMON: 55
```

`components/ShareButtons.tsx` no longer appears in the report — the very-common
count went from 56 to 55. That's the loop: the checker is the source of truth.

> **Hands-off mode:** instead of fixing one by one, tell your Claude Code agent
> *"work through the a11y findings, highest-impact first."* The `grind` skill
> (ROBOT MODE) loops scan → rank by frequency → apply the mechanical fixes →
> propose the judgment ones (never filler) → re-scan to verify each cleared →
> repeat, then reports what it fixed, what needs a human, and what it couldn't see.

**What to do next:** the source scan is half the story — verify the page that
actually ships.

---

## 6. Verify the rendered page — `check-url`

**Why:** the `.tsx` scan needs React source on disk. Plenty of pages don't have
that — a deployed site, an ASP.NET/Razor app, a plain HTML/Bootstrap page, or a
live URL. So the checker has a second producer: it renders the real page in a
browser and runs **axe-core** against the live DOM, flowing every finding through
the *same* corpus / WCAG / enforcement machinery.

One-time: install the browser the render path drives, then point it at any page —
an `http(s)://` URL, a `file://` URL, or a bare local path:

```bash
npx playwright install chromium                 # one time
npx @binclusive/a11y check-url http://localhost:3000   # your dev server
npx @binclusive/a11y check-url ./dist/index.html        # a local .html file
```

**What you'll see** (here, a local Bootstrap page rendered headlessly):

```
a11y-checker — rendering file:///.../index.html and running axe-core

aria-progressbar-name
  .progress-sm > .bg-info.progress-bar[role="progressbar"]
    rule:   aria-progressbar-name  [block]  (rendered-DOM / axe)
    wcag:   WCAG 1.1.1
    ARIA progressbar nodes must have an accessible name
    severity: SERIOUS
    corpus: [COMMON] SC 1.1.1 — 16/26 orgs
    ref:    https://dequeuniversity.com/rules/axe/4.11/aria-progressbar-name

82 finding(s)   COMMON: 7  |  VERY COMMON: 6  |  BASELINE: 69
enforcement: 82 blocking · 0 warning
```

Same tiers, same fixes, same block/warn gate — but findings are anchored on the
axe **CSS selector** instead of a source line, and the `(rendered-DOM / axe)` tag
marks their provenance. A real browser render catches categories static analysis
can't — notably **color-contrast (WCAG 1.4.3)**, computed ARIA roles, and
layout-dependent rules.

The full deep dive — provenance, the corpus edge on rendered-only SCs, why
templates need a running server — is in **[AUDIT-URL.md](AUDIT-URL.md)**.

**What to do next:** scan your other stacks, or skip ahead to the CI gate.

---

## 7. Scan another stack — opt-in, one subcommand each

**Why:** `check` scans `.tsx` only. Every other stack is **opt-in** — you enable it
by running its own `check-<stack>` subcommand; nothing scans a stack you didn't ask
for, and the default `check` never leaves React. Each is a static, in-process pass
(no browser, no second toolchain) whose findings flow through the *same* corpus /
WCAG / enforcement machinery as `check`:

```bash
npx @binclusive/a11y check-swift   ./ios      # .swift — SwiftUI accessibility (static)
npx @binclusive/a11y check-shopify ./theme    # .liquid — Shopify theme structure (static)
npx @binclusive/a11y check-unity   ./Assets   # .prefab / .unity — Unity Force-Text scenes
npx @binclusive/a11y check-android ./app      # res/layout XML — Android layouts
```

Same tiers, same fixes, same finding shape as the `.tsx` and `check-url` reports.

**On gating:** every `check*` command gates the same way. Each exits non-zero when
a finding your contract marks **block** fired, and the exit code is identical across
`text`, `--json`, and `--sarif` output. Tune it with the same flags as `check` —
`--fail-on` / `--max-violations` to set the threshold, `--ci` to run advisory (always
exit 0). So a stack scan gates a job exactly like the `.tsx` scan does (next section).

> With **no** `binclusive.json`, a scan is **advisory**: every finding is
> reported but none block, so the run exits **0** and your build stays green
> ([#184](https://github.com/Binclusive/a11y/issues/184) / ADR 0010). Blocking is
> opt-in — arm it by committing a `binclusive.json` with an `enforcement.block`
> list (run `init`), or by adding a `--fail-on <impact>` / `--max-violations <n>`
> gate flag (the equivalent Action inputs work too).

**What to do next:** make the gate automatic.

---

## 8. Gate CI

**Why:** `check` already exits non-zero on blocking findings. Drop that one line
into your pipeline and any serious/critical finding (the criteria in your
contract's `block` list) fails the PR.

```yaml
# in your CI job
- run: npx -y @binclusive/a11y check ./src
```

The step fails the build exactly when `check` reports blocking findings — the
same gate your contract's `enforcement.block` defines, no extra config. Warnings
don't fail the build; only the criteria you chose to block do.

---

## Two layers, one tool

You now have both halves of the picture, from a single corpus:

1. **Source check** (`check`, the MCP `check_a11y`, the auto-whisper hook) —
   catches bugs in your repo *as you write them*, including inside the
   design-system components a normal linter is blind to.
2. **Live render check** (`check-url`, the MCP `check_url`) — catches what only
   the shipped, rendered page reveals: contrast, computed roles, server-rendered
   and non-React markup.

Same WCAG mapping, same 26-org corpus tiers, same fixes, same block/warn gate.

### Where to go next

| If you want… | Read |
|---|---|
| How the machine works — the code map | [ARCHITECTURE.md](ARCHITECTURE.md) |
| The rendered-DOM / live-URL deep dive | [AUDIT-URL.md](AUDIT-URL.md) |
| Install details + other agents (Cursor, Copilot, …) | [INSTALL.md](INSTALL.md) |
