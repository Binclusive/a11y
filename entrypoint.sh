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

# ---- 1. Resolve the set of changed .tsx files -----------------------------
# Three sources, in priority order: an explicit CHANGED_FILES list, a
# BASE..HEAD git diff, or (fallback) a wholesale scan of a mounted tree.
FILES=""
if [ -n "${CHANGED_FILES:-}" ]; then
  # Space- or newline-separated; unquoted expansion does the splitting.
  FILES=$(printf '%s\n' $CHANGED_FILES | grep -E '\.tsx$' || true)
  log "using CHANGED_FILES"
elif [ -n "${BASE_SHA:-}" ] && [ -n "${HEAD_SHA:-}" ] \
     && git -C "$WORKSPACE" rev-parse --git-dir >/dev/null 2>&1; then
  FILES=$(git -C "$WORKSPACE" diff --name-only "$BASE_SHA"..."$HEAD_SHA" 2>/dev/null \
            | grep -E '\.tsx$' || true)
  log "diffed ${BASE_SHA}...${HEAD_SHA}"
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
