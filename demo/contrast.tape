# contrast.tape — GENERATED from scenario.contrast.json by `demo-kit record`. Do not hand-edit.
# Render:  pnpm exec tsx demo/demo-kit.ts record demo/scenario.contrast.json   (writes demo/contrast.gif + demo/contrast.mp4)
# a11y-checker — the bugs your linter misses, inside your design system

Output demo/contrast.gif
Output demo/contrast.mp4

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
Type "clear"
Enter
Show
Sleep 1s

# =============================================================================
# ACT 1 — same file, two linters: 1 of 3 vs 3 of 3
# =============================================================================
# A normal MUI toolbar. An icon-only IconButton, a placeholder-only TextField,
# a correct Button, and one img. Three of these are real accessibility bugs.
Type "cat demo/contrast/Toolbar.tsx"
Sleep 500ms
Enter
Sleep 7s

# The industry-standard a11y linter — eslint-plugin-jsx-a11y, recommended.
# 1 problem. It thinks you're basically fine.
Type "npx eslint --no-config-lookup --config demo/contrast/eslint.config.mjs demo/contrast/Toolbar.tsx"
Sleep 500ms
Enter
Sleep 7s

# a11y-checker — 3. The two your linter missed are inside MUI, where it can't look:
# a button screen readers can't name (4.1.2), a field with no label (1.3.1). With the fix.
Type "a11y scan demo/contrast"
Sleep 500ms
Enter
Sleep 8s

# Same file: your linter caught 1 of 3. The 2 it missed are the ones that actually
# break the experience — and they're inside your design system.
Type "echo 'eslint: 1 of 3   ·   a11y-checker: 3 of 3   ·   zero false positives on <Button>Save</Button>'"
Sleep 500ms
Enter
Sleep 7s

# cleanup generated files so the repo ends clean
Hide
Type "clear"
Enter
Show
