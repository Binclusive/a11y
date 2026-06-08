# killer.tape — GENERATED from scenario.killer.json by `demo-kit record`. Do not hand-edit.
# Render:  pnpm exec tsx demo/demo-kit.ts record demo/scenario.killer.json   (writes demo/killer.gif + demo/killer.mp4)
# a11y-checker — the bug the linter everyone trusts walks past

Output demo/killer.gif
Output demo/killer.mp4

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
# THE KILLER CUT — eslint-clean vs a11y-checker on real shadcn code
# =============================================================================
# easy-ui — a shadcn kit people install. Here's its share button, real repo.
Type "sed -n '24,30p' demo/.cache/easy-ui/components/ShareButtons.tsx"
Sleep 500ms
Enter
Sleep 7s

# The linter everyone runs — eslint-plugin-jsx-a11y, recommended.
Type "npx eslint --no-config-lookup --config demo/jsx-a11y.config.mjs demo/.cache/easy-ui/components/ShareButtons.tsx && echo '✓ clean — 0 problems'"
Sleep 500ms
Enter
Sleep 7s

# a11y-checker, same file. Icon-only button, no accessible name — a screen reader just says 'button'.
Type "a11y scan demo/.cache/easy-ui/components | sed -n '/ShareButtons.tsx:27/,/fix:/p'"
Sleep 500ms
Enter
Sleep 8s

# And it's not one — across easy-ui's components, every icon-only button is nameless. eslint passed every one.
Type `a11y check demo/.cache/easy-ui/components --json | jq -r '[.findings[] | select(.ruleId=="enforce/button-no-name")] | length | "\\(.) icon-only buttons with no accessible name — eslint passed every one."'`
Sleep 500ms
Enter
Sleep 7s

# Real kit. Real bug. The linter everyone trusts walked right past it.
Type "echo 'eslint: clean   ·   a11y-checker: caught the bug your users feel'"
Sleep 500ms
Enter
Sleep 7s

# cleanup generated files so the repo ends clean
Hide
Type "clear"
Enter
Show
