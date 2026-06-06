#!/usr/bin/env bash
#
# _a11y.sh — the on-screen `a11y` alias, extracted so both demo.sh (live) and
# demo.tape (recorded) share ONE definition. Source this; it defines `a11y`
# and resolves REPO. It runs NO demo steps — safe to source from a clean shell.
#
# The audience sees clean commands like `a11y scan <dir>`; under the hood every
# call resolves to the real CLI (pnpm exec tsx <repo>/src/cli.ts ...).

# Resolve the repo root. When sourced, BASH_SOURCE[0] is this file (<repo>/demo).
if [ -n "${BASH_SOURCE[0]:-}" ]; then
  _A11Y_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  REPO="$(cd "$_A11Y_DIR/.." && pwd)"
else
  REPO="${REPO:-$(pwd)}"
fi
export REPO

# a11y(...) — on-screen alias so typed commands read clean. `scan` reads nicely
# but the CLI subcommand is `check` (scan is only an npm-script alias), so we
# translate the first arg: `a11y scan <dir>` → `... cli.ts check <dir>`.
a11y() {
  local sub="${1:-}"; [ "$#" -gt 0 ] && shift
  [ "$sub" = "scan" ] && sub="check"
  pnpm exec tsx "$REPO/src/cli.ts" "$sub" "$@"
}
export -f a11y 2>/dev/null || true
