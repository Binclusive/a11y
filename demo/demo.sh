#!/usr/bin/env bash
#
# demo.sh — a self-typing presenter script for the a11y-checker.
#
# Inlined demo-magic: `pe` types a command char-by-char, waits for you to press
# Enter, then runs it; `pc` prints a dimmed narration line. No install needed.
#
# Drive it live: run `bash demo/demo.sh` in a tmux pane, then send Enter into
# that pane to advance each step (e.g. `tmux send-keys -t <pane> Enter`).
#
# Pacing: DEMO_SPEED is the per-char typing delay in seconds (default 0.04).
#   DEMO_SPEED=0.02 bash demo/demo.sh   # faster
#   DEMO_SPEED=0.06 bash demo/demo.sh   # slower
#
set -u

# --- locate the repo (this script lives in <repo>/demo/demo.sh) ---------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO"

SAMPLE="demo/sample-app"
DECLARED="$SAMPLE/binclusive.declared.json"

# --- presentation knobs -------------------------------------------------------
TYPE_SPEED="${DEMO_SPEED:-0.04}"   # seconds per character while "typing"

# ANSI: bold cyan for the typed prompt, dim grey for narration.
if [ -t 1 ]; then
  C_PROMPT="\033[1;36m"; C_CMD="\033[1m"; C_DIM="\033[2m"; C_RESET="\033[0m"
else
  C_PROMPT=""; C_CMD=""; C_DIM=""; C_RESET=""
fi
PROMPT="\$ "

# pc "<comment>" — print a dimmed narration line (no command run).
pc() {
  printf "%b# %s%b\n" "$C_DIM" "$1" "$C_RESET"
}

# pe "<cmd>" — type the command out, wait for Enter, then run it.
pe() {
  local cmd="$1"
  printf "%b%s%b%b" "$C_PROMPT" "$PROMPT" "$C_RESET" "$C_CMD"
  local i ch
  for (( i=0; i<${#cmd}; i++ )); do
    ch="${cmd:$i:1}"
    printf "%s" "$ch"
    sleep "$TYPE_SPEED"
  done
  printf "%b" "$C_RESET"
  # Wait for the presenter to press Enter before executing.
  read -r _ < /dev/tty || true
  eval "$cmd"
  echo
}

# a11y(...) — the on-screen alias so typed commands read clean. Resolves to the
# real CLI under the hood; the audience sees `a11y scan ...`, not the tsx path.
a11y() { pnpm exec tsx "$REPO/src/cli.ts" "$@"; }
export -f a11y
export REPO

# --- idempotency: wipe any live-generated config at start AND on exit ---------
clean_generated() {
  rm -f "$SAMPLE/binclusive.json" "$SAMPLE/AGENTS.md" "$SAMPLE/CLAUDE.md"
}
clean_generated
trap clean_generated EXIT

clear 2>/dev/null || true

# =============================================================================
# TITLE CARD
# =============================================================================
cat <<'BANNER'
  ┌───────────────────────────────────────────────────────────────┐
  │                                                               │
  │     a11y-checker — cold-scan accessibility for React          │
  │     resolve components → check structure + content            │
  │                                                               │
  │     Act 1: a tiny sample app, on-ramp                         │
  │     Act 2: real OSS apps, credibility close                   │
  │                                                               │
  └───────────────────────────────────────────────────────────────┘
BANNER
echo
pc "Press Enter after each typed command to run it."
read -r _ < /dev/tty || true
echo

# =============================================================================
# ACT 1 — sample-app on-ramp
# =============================================================================
pc "ACT 1 — a tiny React app (acme-app) with intentional a11y bugs."
pc "Its design system @acme/ui is declared in package.json but NOT installed."
echo
pc "Step 1: a COLD scan. Zero config. The checker resolves every imported"
pc "component to an HTML host and runs structural + content checks."
pe "a11y scan $SAMPLE/src"
pc "What just happened:"
pc "  • caught the intrinsic bugs with ZERO config — <img> with no alt,"
pc "    <a href=\"#\"> going nowhere."
pc "  • caught the icon-only react-router <Link to=\"/settings\"><GearIcon/></Link>"
pc "    — react-router Link/NavLink are recognized as link controls, no config."
pc "  • honestly DECLARED @acme/ui (Button/IconButton/TextField) — it can't see"
pc "    inside a package that isn't on disk, and it SAYS so (missing-deps note)."
pc "  → 3 blocking findings. Exit code 1. That non-zero is EXPECTED."
echo

pc "Step 2: teach the checker the stack. init detects framework + design system"
pc "and writes the policy (binclusive.json + an AGENTS.md/CLAUDE.md block)."
pe "a11y init $SAMPLE"
pc "  → detected: react · @acme/ui · ts. Blocks 1.3.1, 4.1.2, 2.4.4."
echo

pc "Step 3: declare your 3 primitives so the checker can see THROUGH the"
pc "opaque design system. We copy a pristine, post-declare config into place."
pe "cp $DECLARED $SAMPLE/binclusive.json"
pe "cat $SAMPLE/binclusive.json"
pc "  → Button->button, IconButton->button, TextField->input. Three lines."
echo

pc "Step 4: RESCAN. Same code, same app — but now the checker can reach the"
pc "content the app passes INTO @acme/ui's opaque components."
pe "a11y scan $SAMPLE/src"
pc "THE RECALL WIN: 3 findings → 5 findings. The two new ones were hidden"
pc "inside @acme/ui and only surfaced after declaring:"
pc "  • SettingsForm.tsx:20  enforce/input-no-name  — <TextField placeholder=\"Email\"/>"
pc "    (a placeholder is NOT a label)."
pc "  • SettingsForm.tsx:27  enforce/button-no-name  — icon-only <IconButton>."
pc "  And ZERO false positives: the labelled Button, alt'd <img>, and"
pc "  <Link to>text</Link> stay clean."
echo

pc "Step 5: --json makes it CI-ready. Pipe the summary straight into a gate."
if command -v jq >/dev/null 2>&1; then
  pe "a11y check $SAMPLE/src --json | jq '.summary'"
else
  pe "a11y check $SAMPLE/src --json | tail -n 12"
fi
pc "  → keys: tool, root, filesScanned, coverage, findings, summary."
pc "    summary.blocking is your build gate."
echo
pc "End of Act 1. Cleaning the live-generated config so a re-run is pristine."
clean_generated
echo

# =============================================================================
# ACT 2 — credibility close (real OSS, then the cross-stack experiment)
# =============================================================================
pc "ACT 2 — does this hold on REAL code? Two pieces of evidence."
echo

# Resolve a target dir for shadcn-ui/taxonomy (a recognizable Next.js + Radix
# app). Priority: reuse the already-cloned experiment cache (instant), else
# clone a fresh shallow copy into a gitignored demo/.cache. The scan target is
# the REPO ROOT — Taxonomy's .tsx lives across app/ and components/, and the
# root is what the experiment measured (94 files → 14 findings).
TAXONOMY=""
CACHED="experiments/stack-matrix/.cache/shadcn-ui__taxonomy"
FRESH="demo/.cache/shadcn-ui__taxonomy"

if [ -d "$CACHED" ] && find "$CACHED" -name '*.tsx' -not -path '*/node_modules/*' | head -1 | grep -q .; then
  TAXONOMY="$CACHED"
elif [ -d "$FRESH" ] && find "$FRESH" -name '*.tsx' -not -path '*/node_modules/*' | head -1 | grep -q .; then
  TAXONOMY="$FRESH"
else
  pc "Cloning a real shadcn app (shadcn-ui/taxonomy) — shallow, one-time…"
  mkdir -p demo/.cache
  if git clone --depth 1 https://github.com/shadcn-ui/taxonomy "$FRESH" >/dev/null 2>&1 \
     && find "$FRESH" -name '*.tsx' -not -path '*/node_modules/*' | head -1 | grep -q .; then
    TAXONOMY="$FRESH"
  fi
fi

if [ -n "$TAXONOMY" ]; then
  pc "Act 2 — real OSS: even shadcn's own Taxonomy app (Next.js + Radix) has"
  pc "real a11y issues. Zero config, zero false positives."
  pe "a11y scan $TAXONOMY"
  pc "  → 14 blocking findings on a polished, popular app. Mostly"
  pc "    jsx-a11y/heading-has-content (empty headings, 9×) plus a few"
  pc "    anchor + form-name issues. Radix's 104 components read as TRUSTED;"
  pc "    the findings are app-owned content, not framework noise."
  echo
else
  pc "(Skipping the live OSS scan — no taxonomy clone and no network."
  pc " The cross-stack experiment below already covers taxonomy and 19 more.)"
  echo
fi

pc "The cross-stack experiment: 20 OSS React apps × 8 design systems × 4"
pc "frameworks, all cold-scanned out of the box (no init, no declarations)."
pe "sed -n '1,30p' experiments/stack-matrix/REPORT.md"
pc "What this shows:"
pc "  • precision HOLDS across stacks — the zero-FP discipline travels."
pc "  • the big finding clusters are REAL recall, not noise: enforce/input-no-name,"
pc "    enforce/button-no-name top the list — exactly the opaque-component content"
pc "    bugs Act 1 demonstrated, found at scale."
echo

# =============================================================================
# CLOSING CARD
# =============================================================================
cat <<'BANNER'
  ┌───────────────────────────────────────────────────────────────┐
  │                                                               │
  │   Cold scan, zero config:  intrinsic bugs + router links.     │
  │   Declare 3 primitives:    recall jumps 3 → 5 findings.       │
  │   --json:                  drop it straight into CI.          │
  │   shadcn Taxonomy:         14 real findings, zero config.     │
  │   20 OSS repos:            precision holds, recall is real.    │
  │                                                               │
  │   That's the a11y-checker.                                    │
  │                                                               │
  └───────────────────────────────────────────────────────────────┘
BANNER
echo
pc "Demo complete."
