#!/usr/bin/env bash
#
# record-agent.sh — one command to (re)build the "agentic loop" demo.
#   1. set up a throwaway mini React project, write a component the way an AI
#      would (clickable <div>, <img> with no alt), and capture the REAL
#      PostToolUse auto-whisper the `hook` command emits
#   2. write the fixed version and confirm the hook goes silent (clean)
#   3. synthesize demo/agent.cast (make-agent-cast.py) + render demo/agent.gif
#
# The cast is a dramatization of a Claude Code session, but every auto-whisper
# byte is real hook output. Present live: asciinema play demo/agent.cast
set -u
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$REPO"
CAP="${CAP:-/tmp/agent}"; CLI="$REPO/src/cli.ts"
mkdir -p "$CAP/src"

cat > "$CAP/package.json" <<'JSON'
{ "name": "storefront", "type": "module",
  "dependencies": { "react": "^18.3.1", "react-dom": "^18.3.1" } }
JSON
cat > "$CAP/tsconfig.json" <<'JSON'
{ "compilerOptions": { "target":"ES2020","module":"ESNext","moduleResolution":"Bundler","jsx":"react-jsx","strict":true }, "include":["src"] }
JSON

# 1 · the way an AI first writes it
cat > "$CAP/src/ProductCard.tsx" <<'TSX'
export function ProductCard({ product }: { product: Product }) {
  return (
    <div className="card" onClick={() => open(product.id)}>
      <img src={product.image} />
      <h3>{product.name}</h3>
      <span className="price">{product.price}</span>
    </div>
  );
}
TSX
cp "$CAP/src/ProductCard.tsx" "$CAP/before.tsx"
echo '{"tool_name":"Write","tool_input":{"file_path":"'"$CAP"'/src/ProductCard.tsx"},"cwd":"'"$CAP"'"}' \
  | pnpm exec tsx "$CLI" hook 2>/dev/null \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['hookSpecificOutput']['additionalContext'])" > "$CAP/whisper.txt"

# 2 · the fix — and confirm the hook goes silent
cat > "$CAP/src/ProductCard.tsx" <<'TSX'
export function ProductCard({ product }: { product: Product }) {
  return (
    <button type="button" className="card" onClick={() => open(product.id)}>
      <img src={product.image} alt={product.name} />
      <h3>{product.name}</h3>
      <span className="price">{product.price}</span>
    </button>
  );
}
TSX
cp "$CAP/src/ProductCard.tsx" "$CAP/after.tsx"
CLEAN=$(echo '{"tool_name":"Edit","tool_input":{"file_path":"'"$CAP"'/src/ProductCard.tsx"},"cwd":"'"$CAP"'"}' \
  | pnpm exec tsx "$CLI" hook 2>/dev/null)
[ -z "$CLEAN" ] && echo "· captured whisper ($(wc -l <"$CAP/whisper.txt") lines) · fixed version is clean" \
  || { echo "FIX STILL HAS FINDINGS:"; echo "$CLEAN"; exit 1; }

# 3 · synthesize + render
CAP="$CAP" python3 demo/make-agent-cast.py > demo/agent.cast
agg --font-size 18 demo/agent.cast demo/agent.gif >/dev/null 2>&1
echo "· wrote demo/agent.cast ($(wc -c <demo/agent.cast) bytes) + demo/agent.gif ($(wc -c <demo/agent.gif) bytes)"
echo "done. preview live with:  asciinema play demo/agent.cast"
