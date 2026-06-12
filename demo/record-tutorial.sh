#!/usr/bin/env bash
#
# record-tutorial.sh — one command to (re)build the getting-started tutorial demo.
#   1. capture AUTHENTIC bytes from a real run on the cal.com monorepo
#   2. synthesize demo/tutorial.cast (make-tutorial-cast.py)
#   3. render demo/tutorial.gif with agg
#
# Substrate: the real calcom/cal.com Turborepo monorepo (cloned into the
# stack-matrix cache on first run). Targets apps/web — Next app-router + the
# in-repo @calcom/ui design system — so the tutorial proves the checker holds up
# at monorepo scale, not on a toy app.
#
# Present live instead:  asciinema play demo/tutorial.cast
# NB: no `set -e`/`pipefail` — `check` exits non-zero on blocking findings (the
# CI gate), which is expected here.
set -u
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$REPO"
CC="experiments/stack-matrix/.cache/calcom__cal.com"
WEB="$CC/apps/web"; DIR="$WEB/components/booking"
CAP="${CAP:-/tmp/tut}"; CLI="$REPO/src/cli.ts"
mkdir -p "$CAP"
strip() { sed 's/\x1b\[[0-9;]*m//g'; }

# 0 · ensure the monorepo is present
if [ ! -d "$CC/.git" ] && [ ! -f "$WEB/components/booking/CancelBooking.tsx" ]; then
  echo "· cloning calcom/cal.com (shallow) …"
  git clone --depth 1 https://github.com/calcom/cal.com "$CC"
fi

# 1 · init on apps/web  →  next (app router) · @calcom/ui · ts
rm -f "$WEB/binclusive.json" "$WEB/AGENTS.md" "$WEB/CLAUDE.md"
pnpm exec tsx "$CLI" init "$WEB" 2>&1 | strip | grep -E "init —|stack:|enforcement:|wrote:" \
  | sed -E 's#init — .*#init — apps/web#' > "$CAP/init.txt"
rm -f "$WEB/binclusive.json" "$WEB/AGENTS.md" "$WEB/CLAUDE.md"

# 2 · coverage on the booking flow (monorepo auto-traces @calcom/ui from disk)
pnpm exec tsx "$CLI" check "$DIR" 2>&1 | strip > "$CAP/cov_full.txt"
{ grep -E "scanned [0-9]+ \.tsx" "$CAP/cov_full.txt" | sed -E 's#under .*/calcom__cal.com/#under #'
  grep -E "^  checked|^  trusted|^  declare  [0-9]" "$CAP/cov_full.txt"
  grep -E "finding\(s\)|enforcement:" "$CAP/cov_full.txt"; } > "$CAP/coverage.txt"

# 3 · the finding to read (real bug in the cancel-booking note field)
pnpm exec tsx "$CLI" check "$DIR" 2>&1 | strip | perl -ne 'print if /CancelBooking.tsx:66/../fix:/' > "$CAP/finding.txt"
echo "· captured: init, coverage, finding"

# 4 · synthesize + render
CAP="$CAP" python3 demo/make-tutorial-cast.py > demo/tutorial.cast
agg --font-size 18 demo/tutorial.cast demo/tutorial.gif >/dev/null 2>&1
echo "· wrote demo/tutorial.cast ($(wc -c <demo/tutorial.cast) bytes) + demo/tutorial.gif ($(wc -c <demo/tutorial.gif) bytes)"
echo "done. preview live with:  asciinema play demo/tutorial.cast"
