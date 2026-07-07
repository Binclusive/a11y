#!/usr/bin/env bash
#
# record-taxonomy.sh — one command to (re)build the taxonomy demo end to end.
#
#   1. capture AUTHENTIC bytes from the real tools on shadcn/ui taxonomy
#   2. synthesize demo/taxonomy.cast with frame-exact pacing (make-taxonomy-cast.py)
#   3. render demo/taxonomy.gif with agg
#
# Why synthesize rather than `asciinema rec`: headless shells have no TTY, and
# asciinema's headless recorder does not honor real sleeps, so a recorded GIF
# races by. The generator gives deliberate pacing + colored emphasis and embeds
# the real captured output. To present LIVE instead: `asciinema play demo/taxonomy.cast`.
#
# Requires: python3, agg (brew install agg), the taxonomy clone under
# experiments/stack-matrix/.cache (auto-cloned here if missing).
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"
TAX="experiments/stack-matrix/.cache/shadcn-ui__taxonomy"
CAP="${CAP:-/tmp/cap}"

# 0 · ensure the target repo is present
if [ ! -f "$TAX/components/search.tsx" ]; then
  echo "· cloning shadcn/ui taxonomy …"
  mkdir -p "$(dirname "$TAX")"
  git clone --depth 1 https://github.com/shadcn-ui/taxonomy "$TAX"
fi

# 1 · capture authentic bytes
mkdir -p "$CAP"
sed -n '22,33p' "$TAX/components/search.tsx" > "$CAP/source.txt"
pnpm exec tsx "$REPO/src/cli.ts" check "$TAX/components" 2>/dev/null \
  | perl -ne 'print if /search\.tsx/../fix:/' > "$CAP/finding_color.txt" || true
echo "· captured source ($(wc -l <"$CAP/source.txt") lines) + finding ($(wc -l <"$CAP/finding_color.txt") lines)"

# 2 · synthesize the cast
CAP="$CAP" python3 demo/make-taxonomy-cast.py > demo/taxonomy.cast
echo "· wrote demo/taxonomy.cast ($(wc -c <demo/taxonomy.cast) bytes)"

# 3 · render the gif
agg --font-size 18 demo/taxonomy.cast demo/taxonomy.gif >/dev/null 2>&1
echo "· wrote demo/taxonomy.gif ($(wc -c <demo/taxonomy.gif) bytes)"
echo "done. preview live with:  asciinema play demo/taxonomy.cast"
