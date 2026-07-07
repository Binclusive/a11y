#!/usr/bin/env bash
#
# build.sh — refresh the showcase's cast copies from the source casts, so
# demo/player/ is a self-contained, deployable static site.
#
#   bash demo/player/build.sh           # copy ../*.cast → ./casts/
#   npx wrangler pages deploy demo/player --project-name a11y-checker-demos
#
# The source of truth is demo/<name>.cast (rebuilt by demo/record-<name>.sh);
# ./casts/ is a build output (gitignored). The player lib in vendor/ is committed.
set -eu
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$DIR/casts"
for n in taxonomy tutorial config oss agent; do
  cp "$DIR/../$n.cast" "$DIR/casts/$n.cast"
done
echo "· refreshed $(ls "$DIR/casts" | wc -l | tr -d ' ') casts → demo/player/casts/"
