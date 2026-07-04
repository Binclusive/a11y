#!/usr/bin/env sh
# Tracer-bullet CI wrapper around @binclusive/a11y (issue #2089).
#
# Finds the changed .tsx files, runs the engine's STATIC (no-browser) check on
# them, prints the findings JSON to stdout, and — when a PR context + token are
# present — posts each finding as an inline PR review comment.
#
# ALWAYS exits 0: this gate is advisory. A blocking finding sets the engine's
# own exit code to 1; we deliberately swallow it so the workflow never fails.
set -u

ENGINE_DIR="${ENGINE_DIR:-/engine}"
WORKSPACE="${GITHUB_WORKSPACE:-$(pwd)}"

log() { echo "a11y-agent: $*" >&2; }

# A Docker action runs as root over a workspace whose .git is owned by the
# runner user, so git's dubious-ownership guard would make every git call fail
# (silently falling back to a no-op scan). Trust the mounted workspace.
git config --global --add safe.directory "$WORKSPACE" 2>/dev/null || true

# The runner passes the GITHUB_* defaults into a Docker action but NOT the PR
# context — derive PR_NUMBER / BASE_SHA / HEAD_SHA from the event payload at
# GITHUB_EVENT_PATH. Explicit env still wins, so `docker run -e ...` works too.
if [ -n "${GITHUB_EVENT_PATH:-}" ] && [ -f "${GITHUB_EVENT_PATH:-}" ]; then
  ev() { node -e 'const fs=require("fs");const e=JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH,"utf8"));const g=(o,p)=>p.split(".").reduce((a,k)=>a&&a[k],o);process.stdout.write(String(g(e,process.argv[1])??""))' "$1" 2>/dev/null; }
  export PR_NUMBER="${PR_NUMBER:-$(ev number)}"
  export BASE_SHA="${BASE_SHA:-$(ev pull_request.base.sha)}"
  export HEAD_SHA="${HEAD_SHA:-$(ev pull_request.head.sha)}"
fi

# ---- 1. Resolve the set of changed .tsx files -----------------------------
# Delegated to the engine's ONE diff-scoping module (src/diff-scope.ts) via
# bin/diff-scope.mjs, so the Action and the engine share a single scoper instead
# of a second copy of the priority logic in shell. It reads CHANGED_FILES /
# BASE_SHA / HEAD_SHA / GITHUB_WORKSPACE (explicit list first, then a BASE..HEAD
# git diff) and prints the changed .tsx paths — empty output means no diff
# context, so the wholesale-scan fallback below takes over.
FILES=$(GITHUB_WORKSPACE="$WORKSPACE" node "$ENGINE_DIR/bin/diff-scope.mjs" 2>/dev/null || true)
if [ -n "$FILES" ]; then
  log "scoped changed .tsx via diff-scope"
fi

REPORT=$(mktemp)

if [ -n "$FILES" ]; then
  # Stage the changed files into a mirror dir so the engine's directory-based
  # `check` reports repo-relative paths — the exact form the PR comment API
  # (path + line) needs.
  STAGE=$(mktemp -d)
  n=0
  for f in $FILES; do
    src="$WORKSPACE/$f"
    [ -f "$src" ] || continue
    mkdir -p "$STAGE/$(dirname "$f")"
    cp "$src" "$STAGE/$f"
    n=$((n + 1))
  done
  log "scanning $n changed .tsx file(s)"
  node "$ENGINE_DIR/bin/a11y.mjs" check "$STAGE" --json > "$REPORT" 2>/dev/null || true
else
  # Fallback: no diff context — scan a mounted tree wholesale (default /src).
  SCAN_DIR="${SCAN_DIR:-/src}"
  if [ -d "$SCAN_DIR" ]; then
    log "no changed-file context; scanning $SCAN_DIR"
    node "$ENGINE_DIR/bin/a11y.mjs" check "$SCAN_DIR" --json > "$REPORT" 2>/dev/null || true
  else
    log "nothing to scan (no changed files and no $SCAN_DIR)"
    printf '%s\n' '{"tool":"a11y-checker","findings":[],"summary":{"findings":0,"blocking":0,"warning":0}}' > "$REPORT"
  fi
fi

# ---- 2. Emit the findings JSON to stdout ----------------------------------
cat "$REPORT"

# ---- 3. Post inline PR review comments (best-effort) ----------------------
if [ -n "${GITHUB_TOKEN:-}" ] && [ -n "${GITHUB_REPOSITORY:-}" ] \
   && [ -n "${PR_NUMBER:-}" ] && [ -n "${HEAD_SHA:-}" ]; then
  log "posting inline review comments to PR #$PR_NUMBER"
  node "$ENGINE_DIR/pr-comment.mjs" "$REPORT" || log "comment step failed (ignored)"
else
  log "no PR context/token — skipping inline comments"
fi

# Advisory gate: never fail the workflow.
exit 0
