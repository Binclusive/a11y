# umut.tape — GENERATED from scenario.umut.json by `demo-kit record`. Do not hand-edit.
# Render:  pnpm exec tsx demo/demo-kit.ts record demo/scenario.umut.json   (writes demo/umut.gif + demo/umut.mp4)
# a11y-checker — the audit corpus, shifted left into the editor

Output demo/umut.gif
Output demo/umut.mp4

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
# ACT 1 — the audit bridge: every finding is weighted by the real corpus
# =============================================================================
# Same React app, design system @acme/ui declared. Drop the post-declare config in place,
# so the checker sees THROUGH the opaque package to the content passed in.
Type "cp $FIX/binclusive.declared.json $FIX/binclusive.json"
Sleep 500ms
Enter
Sleep 4s

# Now SCAN. Every finding carries the audit weight: [TIER] SC X — N/26 orgs,
# the distilled seen-in-the-wild failure shapes, and the fix that worked. The audit corpus,
# shifted left into the editor — weighting and fixing each finding before it ships.
Type "a11y scan $FIX/src"
Sleep 500ms
Enter
Sleep 9s

# The data beat — for someone who lives in audit data. Tag every finding with its
# corpus weight in structured form: rule, WCAG SC, org count, tier. This is the audit
# system's own signal, now riding on each editor/CI finding.
Type "a11y check $FIX/src --json | jq '[.findings[] | {rule: .ruleId, wcag: .wcag[0], orgs: .corpus.orgs, tier: .corpus.tier}]'"
Sleep 500ms
Enter
Sleep 8s

# The human-knowledge loop. Auditors encode conventions the corpus can't infer.
# `learn` writes the rule into the config AND a managed AGENTS.md / CLAUDE.md block —
# so an AI assistant honors it BEFORE it writes the offending code.
Type 'a11y learn "Every icon-only IconButton must pass an aria-label; never ship a bare icon control." --wcag 4.1.2 $FIX'
Sleep 500ms
Enter
Sleep 6s

# Confirm it landed — the learned rule sits in the managed block, alongside the
# corpus patterns, ready for any agent reading AGENTS.md.
Type "grep -A1 'Learned (this repo)' $FIX/AGENTS.md"
Sleep 500ms
Enter
Sleep 7s

# =============================================================================
# ACT 2 — the corpus generalizes at scale: 27 repos × 7 frameworks × 11 design systems
# =============================================================================
# Does the corpus-weighted check hold beyond the fixture? The Stack-Matrix:
# the same cold scan across 27 real OSS repos, 7 frameworks, 11 design systems.
# Precision holds; recall is real — the audit corpus you build, running everywhere.
Type "sed -n '1,32p' experiments/stack-matrix/REPORT.md"
Sleep 500ms
Enter
Sleep 9s

# cleanup generated files so the repo ends clean
Hide
Type "rm -f demo/sample-app/binclusive.json demo/sample-app/AGENTS.md demo/sample-app/CLAUDE.md"
Enter
Type "clear"
Enter
Show
