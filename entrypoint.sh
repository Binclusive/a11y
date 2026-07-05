#!/usr/bin/env sh
# Tracer-bullet CI wrapper around @binclusive/a11y (issue #2089).
#
# Finds the changed .tsx files, runs the engine's STATIC (no-browser) check on
# them, prints the findings JSON to stdout, and — when a PR context + token are
# present — posts each finding as an inline PR review comment.
#
# Exits 0 BY DEFAULT: this gate is advisory. A blocking finding sets the engine's
# own exit code to 1; we deliberately swallow it so the workflow never fails —
# UNLESS a customer opts into the severity/volume gate via the FAIL_ON /
# MAX_VIOLATIONS inputs (#2134), in which case the engine's non-zero exit is
# propagated (see GATE_EXIT below) so the check fails. Default stays non-blocking.
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

# Both credentials are OPTIONAL and independent — the deterministic floor runs
# without either. LLM_API_KEY (BYOK, the customer's own model key) gates the AI
# lane; B8E_TOKEN (a `b8e_` apiKey) gates phone-home ingestion. Absent key -> no
# AI lane; absent token -> no phone-home; neither is an error. Both reach the
# runner as inherited container env; log presence only, never the secret value.
[ -n "${LLM_API_KEY:-}" ] && log "AI lane: LLM key present" || log "AI lane: no LLM key — deterministic floor only"
# Surface any model/provider override so a customer who sets one sees it took
# (the #2188 complaint was a silently-ignored override). Empty → engine default.
[ -n "${LLM_PROVIDER:-}" ] && log "AI lane: provider override -> $LLM_PROVIDER"
[ -n "${LLM_MODEL:-}" ]    && log "AI lane: model override -> $LLM_MODEL"
[ -n "${B8E_TOKEN:-}" ]   && log "phone-home: b8e_ token present" || log "phone-home: no token — local-only"

# ---- Opt-in blocking gate (#2134), DEFAULT OFF -----------------------------
# FAIL_ON / MAX_VIOLATIONS are OPTIONAL. Absent (empty) → GATE_ARGS stays empty,
# so `check` runs WITHOUT the gate flags and exits 0 on any findings — today's
# non-blocking behavior, unchanged. Set either and the engine's `check` exits
# non-zero when the threshold/volume is met; GATE_EXIT carries that code to the
# final `exit` so the Action fails. Gate is strictly opt-in — safe state by default.
GATE_ARGS=""
[ -n "${FAIL_ON:-}" ]        && GATE_ARGS="$GATE_ARGS --fail-on $FAIL_ON"
[ -n "${MAX_VIOLATIONS:-}" ] && GATE_ARGS="$GATE_ARGS --max-violations $MAX_VIOLATIONS"
[ -n "$GATE_ARGS" ] && log "blocking gate ON:$GATE_ARGS" || log "blocking gate: off (default non-blocking)"
GATE_EXIT=0

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
  SCAN_TARGET="$STAGE"
  # The --json scan is the authoritative gate run: `check` writes the report and
  # THEN sets its exit from the (opt-in) gate, so REPORT is complete even on a
  # non-zero gate exit. GATE_ARGS is empty by default → exit 0 → non-blocking.
  node "$ENGINE_DIR/bin/a11y.mjs" check "$STAGE" --json $GATE_ARGS > "$REPORT" 2>/dev/null
  GATE_EXIT=$?
else
  # Fallback: no diff context — scan a mounted tree wholesale (default /src).
  SCAN_DIR="${SCAN_DIR:-/src}"
  if [ -d "$SCAN_DIR" ]; then
    log "no changed-file context; scanning $SCAN_DIR"
    SCAN_TARGET="$SCAN_DIR"
    node "$ENGINE_DIR/bin/a11y.mjs" check "$SCAN_DIR" --json $GATE_ARGS > "$REPORT" 2>/dev/null
    GATE_EXIT=$?
  else
    log "nothing to scan (no changed files and no $SCAN_DIR)"
    SCAN_TARGET=""
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

# ---- 3.5 Consolidated PR summary + rollup (best-effort) -------------------
# Writes the GitHub Actions job summary UNCONDITIONALLY (visible on the run page
# even with no PR context — push / manual dispatch) and, when a PR context is
# present, posts/updates the ONE rollup comment in place (issue #2132). The CLI
# decides which surfaces apply from its env and always exits 0 — advisory.
log "writing PR summary + rollup"
node "$ENGINE_DIR/pr-summary.mjs" "$REPORT" || log "summary step failed (ignored)"

# ---- 4. Emit SARIF for GitHub code-scanning native annotations ------------
# Render the SAME findings as SARIF 2.1.0 into the workspace. This Action only
# EMITS the file (a Docker action cannot invoke another action); the consumer's
# workflow uploads it with a `github/codeql-action/upload-sarif` step, which
# needs `permissions: security-events: write`. That step turns the findings into
# native inline annotations on the PR diff — the reference code-scanning UX,
# distinct from and additive to the inline PR comments above. The file path is
# exposed as the `sarif-file` output so the upload step can point at it. Always
# written (even with zero findings) so an empty SARIF clears previously-fixed
# alerts rather than leaving stale annotations.
SARIF_OUT="${SARIF_OUTPUT:-$WORKSPACE/a11y.sarif}"
RUN_ID="${GITHUB_RUN_ID:-${HEAD_SHA:-local}}"
if [ -n "$SCAN_TARGET" ]; then
  node "$ENGINE_DIR/bin/a11y.mjs" check "$SCAN_TARGET" --sarif --run-id "$RUN_ID" > "$SARIF_OUT" 2>/dev/null || true
fi
# Safety net: if there was no scan target (no diff + no /src) or the render came
# back empty, still write a valid empty SARIF run so the upload step succeeds.
if [ ! -s "$SARIF_OUT" ]; then
  printf '%s\n' '{"$schema":"https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json","version":"2.1.0","runs":[{"tool":{"driver":{"name":"Binclusive","informationUri":"https://binclusive.io","rules":[]}},"results":[],"automationDetails":{"id":"binclusive-a11y/'"$RUN_ID"'"}}]}' > "$SARIF_OUT"
fi
log "wrote SARIF -> $SARIF_OUT"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  # Path relative to the workspace — the upload step's default working directory.
  echo "sarif-file=$(basename "$SARIF_OUT")" >> "$GITHUB_OUTPUT"
fi

# Exit: NON-BLOCKING by default (GATE_EXIT stays 0 — the advisory floor). Only a
# customer who opted into the gate (FAIL_ON / MAX_VIOLATIONS) gets a non-zero
# exit, carried here from the authoritative --json scan, which the runner
# surfaces as an Action failure. Every side effect above (inline comments, PR
# summary, SARIF) ran regardless, so opting in never suppresses the output.
exit "${GATE_EXIT:-0}"
