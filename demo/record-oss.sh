#!/usr/bin/env bash
#
# record-oss.sh — one command to (re)build the "State of OSS a11y" data demo.
#   1. recompute stats.json from experiments/stack-matrix/results/*.json
#   2. synthesize demo/oss.cast (make-oss-cast.py)
#   3. render demo/oss.gif with agg
#
# Pure data cast — no repo cloning. Every number is recomputed live from the
# real scan results already in the repo. Present live: asciinema play demo/oss.cast
set -u
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$REPO"
CAP="${CAP:-/tmp/oss}"; mkdir -p "$CAP"

python3 - "$REPO/experiments/stack-matrix/results" "$CAP/stats.json" <<'PY'
import json, glob, os, sys
results, out = sys.argv[1], sys.argv[2]
PRETTY = {
  "shadcn-ui__taxonomy":      "shadcn/ui · taxonomy",
  "untitleduico__react":      "Untitled UI · React",
  "umijs__umi":               "umijs / umi  (Alibaba)",
  "googleanalytics__ga-dev-tools": "Google · ga-dev-tools",
  "antiwork__shortest":       "Antiwork · shortest",
  "DarkInventor__easy-ui":    "easy-ui  (shadcn kit)",
  "jolbol1__jolly-ui":        "jolly-ui  (shadcn registry)",
  "Supernova3339__changerawr":"changerawr",
}
rows=[]; tot=0; rule={}
for f in glob.glob(os.path.join(results,"*.json")):
    slug=os.path.basename(f)[:-5]
    try: d=json.load(open(f))
    except: continue
    fs=d.get("findings") or []
    enf=[x for x in fs if (x.get("ruleId") or "").startswith("enforce/")]
    for x in enf: rule[x["ruleId"]]=rule.get(x["ruleId"],0)+1
    tot+=len(enf)
    rows.append({"slug":slug,"pretty":PRETTY.get(slug),"total":len(fs),"enf":len(enf)})
rows.sort(key=lambda r:-r["enf"])
stats={
  "scanned": len(rows),
  "with_bug": sum(1 for r in rows if r["enf"]>0),
  "total_enf": tot,
  "rules": {k.split('/')[1]:v for k,v in sorted(rule.items(),key=lambda x:-x[1])},
  # the recognizable hall-of-fame (named), then the high-count kits
  "named": [r for r in rows if r["pretty"] and r["enf"]>0],
}
json.dump(stats, open(out,"w"), indent=2)
print(f"· stats: {stats['scanned']} repos · {stats['with_bug']} with the bug · {stats['total_enf']} nameless controls")
PY

CAP="$CAP" python3 demo/make-oss-cast.py > demo/oss.cast
agg --font-size 18 demo/oss.cast demo/oss.gif >/dev/null 2>&1
echo "· wrote demo/oss.cast ($(wc -c <demo/oss.cast) bytes) + demo/oss.gif ($(wc -c <demo/oss.gif) bytes)"
echo "done. preview live with:  asciinema play demo/oss.cast"
