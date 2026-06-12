#!/usr/bin/env bash
#
# record-config.sh — one command to (re)build the binclusive.json config demo.
#   1. capture AUTHENTIC config bytes from a real run on calcom/cal.com (apps/web)
#   2. synthesize demo/config.cast (make-config-cast.py)
#   3. render demo/config.gif with agg
#
# Same monorepo substrate as the tutorial, so the through-line holds. Shows the
# real contract init writes, the 30-mapping --suggest scaffold, and a real
# `learn` entry. Present live:  asciinema play demo/config.cast
set -u
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$REPO"
WEB="experiments/stack-matrix/.cache/calcom__cal.com/apps/web"
CAP="${CAP:-/tmp/cfg}"; CLI="$REPO/src/cli.ts"
mkdir -p "$CAP"; strip() { sed 's/\x1b\[[0-9;]*m//g'; }
clean() { rm -f "$WEB/binclusive.json" "$WEB/AGENTS.md" "$WEB/CLAUDE.md"; }

if [ ! -d "$WEB" ]; then echo "cal.com not cloned — run demo/record-tutorial.sh first."; exit 1; fi

# 1 · base contract (plain init, no components)
clean; pnpm exec tsx "$CLI" init "$WEB" >/dev/null 2>&1
cp "$WEB/binclusive.json" "$CAP/base.json"

# 2 · --suggest scaffold output (trimmed to ~8, keeping a ⚠) + full config
clean; pnpm exec tsx "$CLI" init --suggest "$WEB" 2>&1 | strip > "$CAP/suggest_full.txt"
cp "$WEB/binclusive.json" "$CAP/full.json"
TOTAL=$(grep -cE "→" "$CAP/suggest_full.txt")
{ grep -E "suggested [0-9]+ component" "$CAP/suggest_full.txt"
  grep -E "→ .*✓" "$CAP/suggest_full.txt" | head -6
  grep -E "→.*⚠" "$CAP/suggest_full.txt" | head -2
  echo "    … +$((TOTAL-8)) more — eyeball the ⚠ before committing"; } > "$CAP/suggest.txt"
python3 -c "import json;d=json.load(open('$CAP/full.json'))['components'];\
items=list(d.items());\
open('$CAP/components.txt','w').write('\n'.join(f'  \"{k}\": \"{v}\",' for k,v in items[:9])+f'\n  … +{len(items)-9} more')"

# 3 · a real learn entry
clean; pnpm exec tsx "$CLI" init "$WEB" >/dev/null 2>&1
pnpm exec tsx "$CLI" learn "Icon-only buttons must have an aria-label" --wcag 4.1.2 \
  --fix "Add aria-label to icon-only controls" "$WEB" 2>&1 | strip | grep -E "learned|block:" > "$CAP/learn.txt"
python3 -c "import json;e=json.load(open('$WEB/binclusive.json'))['learned'][0];\
print(json.dumps({k:e[k] for k in ('id','rule','wcag','fix','source')},indent=2))" > "$CAP/learned.txt"
clean
echo "· captured: base, suggest, components, learn, learned"

# 4 · synthesize + render
CAP="$CAP" python3 demo/make-config-cast.py > demo/config.cast
agg --font-size 18 demo/config.cast demo/config.gif >/dev/null 2>&1
echo "· wrote demo/config.cast ($(wc -c <demo/config.cast) bytes) + demo/config.gif ($(wc -c <demo/config.gif) bytes)"
echo "done. preview live with:  asciinema play demo/config.cast"
