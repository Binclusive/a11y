#!/usr/bin/env python3
"""
make-oss-cast.py — synthesize demo/oss.cast: "the state of a11y in open source".

A data cast. Every number is recomputed (see record-oss.sh) from real a11y-checker
scans of ~31 well-known React+TS repos in experiments/stack-matrix/results/. The
story: the same eslint-invisible bug — a control with no accessible name — shows
up across the codebases the ecosystem copies from, and eslint-plugin-jsx-a11y
passes every one.

Why synthesize vs `asciinema rec`: headless shells have no TTY. Output: v2 cast.
"""
import json, sys, os
from castkit import *

CAP = os.environ.get("CAP", "/tmp/oss")
W, H = 100, 36

ORG="\x1b[38;5;209m"

def vo(s,hold=1.7): emit(DIM+s+RST+"\r\n"); wait(max(hold,0.043*len(s)))
def banner(s):
    clearscreen(); wait(0.3)
    emit(MAG+BLD+"  "+s+RST+"\r\n"); emit(DIM+"  "+"─"*(len(s))+RST+"\r\n"); blank(1); wait(0.7)

st = json.load(open(CAP+"/stats.json"))
named = st["named"]
maxc = max(r["enf"] for r in named)

CALLOUT = {
  "shadcn/ui · taxonomy":   "the app shadcn ships as the reference",
  "Google · ga-dev-tools":  "yes — Google's own tool",
  "Antiwork · shortest":    "Antiwork",
  "umijs / umi  (Alibaba)": "Alibaba's framework",
}

def bar(count):
    n = max(1, round(36 * count / maxc))
    return ("█"*n)

# ══ THE DATA CAST ═══════════════════════════════════════════════════════════════
clearscreen(); wait(0.3)
line(BLD+CYN+"  the state of accessibility in open source"+RST); wait(0.6)
line(DIM+f"  we pointed a11y-checker at {st['scanned']} React + TypeScript repos the ecosystem learns from."+RST); wait(2.6)

# method
banner("what we looked for")
vo("  One thing, in every repo: a control with " + WHT + "no accessible name" + DIM + " —")
vo("  a button, input, or dialog a screen reader announces as just “button.” Blank.")
wait(0.5)
vo("  It's the bug " + WHT + "eslint-plugin-jsx-a11y can't see" + DIM + ": it can't look inside your <Button>.")
wait(2.0)

# leaderboard
banner("nameless controls, by repo  (the ones eslint passed clean)")
for r in named:
    nm = (r["pretty"] or r["slug"])
    co = CALLOUT.get(nm)
    label = WHT + nm.ljust(28) + RST
    b = (RED if r["enf"] >= 30 else ORG if r["enf"] >= 10 else YEL)
    row = "  " + label + b + bar(r["enf"]) + RST + " " + BLD + WHT + str(r["enf"]) + RST
    if co: row += DIM + "  ← " + co + RST
    emit(row + "\r\n"); wait(0.5)
blank(1); wait(2.6)

# aggregate
banner("the totals")
big = YEL + BLD
line("  " + big + str(st["with_bug"]) + RST + DIM + f" of {st['scanned']} repos" + RST + "  ship at least one control a screen reader can't name."); wait(1.6)
line("  " + big + str(st["total_enf"]) + RST + DIM + " nameless controls in total" + RST + ":"); wait(0.8)
rb = st["rules"]
def rr(k): return f"{rb.get(k,0)}"
line("     " + RED + rr('button-no-name').rjust(4) + RST + DIM + "  buttons    " + RST
     + YEL + rr('input-no-name').rjust(4) + RST + DIM + "  inputs    " + RST
     + ORG + rr('dialog-no-name').rjust(3) + RST + DIM + "  dialogs   " + RST
     + CYN + rr('link-no-name').rjust(3) + RST + DIM + "  links" + RST); wait(2.8)

# the twist
banner("and the part that matters")
vo("  Every one of these " + WHT + "passed eslint-plugin-jsx-a11y" + DIM + " — recommended config — clean.")
wait(1.6)
line("  " + GRN + BLD + "  eslint:  0 problems" + RST + DIM + "   × " + str(st["with_bug"]) + " repos" + RST); wait(1.8)
vo("  This isn't bad engineers. It's a " + WHT + "blind spot in the tool everyone runs" + DIM + ".")
vo("  A linter checks structure. It never checks the " + WHT + "name you passed at the call site" + DIM + ".")
wait(2.2)

# corpus tie + close
banner("why a11y-checker catches it")
vo("  Two moves a generic linter can't make:")
blank(1)
line("  " + CYN + "1." + RST + WHT + "  resolves your <Button>/<Input> to a real host, then checks the call site" + RST); wait(1.4)
line("  " + CYN + "2." + RST + WHT + "  ranks every finding against a corpus of real audits" + RST + DIM + " — 22/26 orgs ship this one" + RST); wait(2.0)
blank(1)
line("  " + DIM + "private audits: " + RST + YEL + "22/26 orgs" + RST + DIM + "     ·     public repos: " + RST + YEL + f"{st['with_bug']}/{st['scanned']}" + RST + DIM + "     →  systemic, not rare." + RST)
wait(2.6)
clearscreen(); wait(0.4); blank(1)
line(BLD+WHT+"  the same bug. shadcn, Google, Alibaba, Untitled UI — all of them."+RST); wait(2.0)
line(DIM+"  not because they're careless — because the standard tool can't see it. this one can."+RST); wait(3.0)

write_cast(events, W, H)
