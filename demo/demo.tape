# demo.tape — GENERATED from demo/scenario.json by `demo-kit record`. Do not hand-edit.
# Render:  pnpm demo:record   (writes demo/demo.gif + demo/demo.mp4)
# a11y-checker — see THROUGH your design system

Output demo/demo.gif
Output demo/demo.mp4

Set Shell "bash"
Set Theme "Catppuccin Mocha"
Set FontSize 16
Set Width 1200
Set Height 760
Set Padding 18
Set TypingSpeed 45ms

# hidden setup — source the alias, bind the fixture var, clear screen
Hide
Type "source demo/_a11y.sh"
Enter
Type "FIX=demo/sample-app"
Enter
Type "clear"
Enter
Show
Sleep 1s

# =============================================================================
# ACT 1 — sample-app on-ramp: declare your design system, recover hidden findings
# =============================================================================
# A tiny React app whose design system @acme/ui is DECLARED but NOT installed.
# Step 1 — a COLD scan. Zero config: resolve every component, check structure + content.
Type "a11y scan $FIX/src"
Sleep 500ms
Enter
Sleep 7s

# Step 2 — teach the checker the stack. init detects framework + design system.
Type "a11y init $FIX"
Sleep 500ms
Enter
Sleep 5s

# Step 3 — declare your 3 primitives so the checker sees THROUGH the opaque package.
Type "cp $FIX/binclusive.declared.json $FIX/binclusive.json"
Sleep 500ms
Enter
Sleep 4s

Type "cat $FIX/binclusive.json"
Sleep 500ms
Enter
Sleep 6s

# Step 4 — RESCAN. Same code; the checker now reaches the content passed INTO @acme/ui.
# THE RECALL WIN: 3 → 5 findings. Two were hidden inside the opaque components.
Type "a11y scan $FIX/src"
Sleep 500ms
Enter
Sleep 7s

# Step 5 — --json makes it CI-ready. Pipe summary.blocking straight into a build gate.
Type "a11y check $FIX/src --json | jq '.summary'"
Sleep 500ms
Enter
Sleep 6s

# =============================================================================
# ACT 2 — credibility close: real OSS code, then the cross-stack experiment
# =============================================================================
# Does this hold on REAL code? shadcn's own Taxonomy app (Next.js + Radix).
# Radix reads as TRUSTED; the findings are app-owned content, not framework noise.
Type "a11y scan experiments/stack-matrix/.cache/shadcn-ui__taxonomy"
Sleep 500ms
Enter
Sleep 7s

# The experiment: 20 OSS React apps × 8 design systems × 4 frameworks. Precision HOLDS.
Type "sed -n '1,30p' experiments/stack-matrix/REPORT.md"
Sleep 500ms
Enter
Sleep 7s

# cleanup generated files so the repo ends clean
Hide
Type "rm -f demo/sample-app/binclusive.json demo/sample-app/AGENTS.md demo/sample-app/CLAUDE.md"
Enter
Type "clear"
Enter
Show
