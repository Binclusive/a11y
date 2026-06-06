# demo.tape — a recorded walkthrough of the a11y-checker, driven by VHS.
#
# Render:  vhs demo/demo.tape   (writes demo/demo.gif + demo/demo.mp4)
#
# Two acts, mirroring demo/demo.sh:
#   ACT 1 — sample-app on-ramp: cold scan (3) → declare design system → rescan (5).
#   ACT 2 — credibility close: shadcn Taxonomy (14 real findings) + the 20-repo matrix.
#
# The on-screen `a11y scan …` alias is defined in demo/_a11y.sh (sourced in a
# hidden block so the terminal reads clean, not the raw tsx path).

Output demo/demo.gif
Output demo/demo.mp4

Set Shell "bash"
Set Theme "Catppuccin Mocha"
Set FontSize 16
Set Width 1200
Set Height 760
Set Padding 18
Set TypingSpeed 45ms

# --- hidden setup: source the alias, clear the screen --------------------------
Hide
Type "source demo/_a11y.sh"
Enter
Type "rm -f demo/sample-app/binclusive.json demo/sample-app/AGENTS.md demo/sample-app/CLAUDE.md"
Enter
Type "clear"
Enter
Show

Sleep 1s

# =============================================================================
# ACT 1 — sample-app on-ramp
# =============================================================================

# ACT 1 — a tiny React app whose design system @acme/ui is declared but NOT installed.
# Step 1: a COLD scan. Zero config — resolve every component, check structure + content.
Type "a11y scan demo/sample-app/src"
Sleep 500ms
Enter
Sleep 6s
# → 3 blocking findings: <img> no alt, <a href="#">, icon-only router <Link>.
#   @acme/ui is honestly DECLARED (missing-deps note) — can't see inside an uninstalled pkg.
Sleep 4s

# Step 2: teach the checker the stack. init detects framework + design system.
Type "a11y init demo/sample-app"
Sleep 500ms
Enter
Sleep 3s
# → detected: react · @acme/ui · ts. Writes binclusive.json + an AGENTS/CLAUDE block.
Sleep 3s

# Step 3: declare your 3 primitives so the checker sees THROUGH the opaque design system.
Type "cp demo/sample-app/binclusive.declared.json demo/sample-app/binclusive.json"
Sleep 500ms
Enter
Sleep 1s
Type "cat demo/sample-app/binclusive.json"
Sleep 500ms
Enter
Sleep 4s
# → Button→button, IconButton→button, TextField→input. Three lines.

# Step 4: RESCAN. Same code — now the checker reaches the content passed INTO @acme/ui.
Type "a11y scan demo/sample-app/src"
Sleep 500ms
Enter
Sleep 6s
# THE RECALL WIN: 3 → 5 findings. The two new ones were hidden inside @acme/ui:
#   enforce/input-no-name (placeholder is not a label) + enforce/button-no-name (icon-only).
Sleep 4s

# Step 5: --json makes it CI-ready. Pipe the summary straight into a build gate.
Type "a11y check demo/sample-app/src --json | jq '.summary'"
Sleep 500ms
Enter
Sleep 5s
# → summary.blocking is your build gate.
Sleep 3s

# clean the live-generated config so the recording is pristine
Hide
Type "rm -f demo/sample-app/binclusive.json demo/sample-app/AGENTS.md demo/sample-app/CLAUDE.md"
Enter
Type "clear"
Enter
Show
Sleep 1s

# =============================================================================
# ACT 2 — credibility close (real OSS, then the cross-stack experiment)
# =============================================================================

# ACT 2 — does this hold on REAL code? Even shadcn's own Taxonomy app (Next.js + Radix).
Type "a11y scan experiments/stack-matrix/.cache/shadcn-ui__taxonomy"
Sleep 500ms
Enter
Sleep 7s
# → 14 blocking findings on a polished, popular app. Radix's components read as TRUSTED;
#   the findings are app-owned content, not framework noise. Zero config, zero false positives.
Sleep 4s

# The cross-stack experiment: 20 OSS React apps × 8 design systems × 4 frameworks.
Type "sed -n '1,30p' experiments/stack-matrix/REPORT.md"
Sleep 500ms
Enter
Sleep 5s
# → precision HOLDS across stacks; the big clusters (input-no-name, button-no-name)
#   are REAL recall — the opaque-component bugs from Act 1, found at scale.
Sleep 5s
