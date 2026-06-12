#!/usr/bin/env python3
"""
make-agent-cast.py — synthesize demo/agent.cast: the agentic loop.

A dramatization of a Claude Code session: the AI writes a component the common
(broken) way, the PostToolUse auto-whisper hook fires UNASKED, and the model
fixes it in the same turn. The session framing is staged, but every auto-whisper
line is REAL output captured from the `hook` command (see record-agent.sh).

Why synthesize vs `asciinema rec`: headless shells have no TTY. Output: v2 cast.
"""
import json, sys, os
from castkit import *

CAP = os.environ.get("CAP", "/tmp/agent")
W, H = 98, 36

ORG="\x1b[38;5;215m"

# this cast's narration lines hold by default, so line() waits even when dt is 0:
def line(s="",dt=0.06): emit(s+"\r\n"); wait(dt)

def user(prompt):
    wait(0.4); emit(BLU+BLD+"> "+RST)
    for ch in prompt:
        emit(BLU+ch+RST); wait(0.028)
    emit("\r\n"); wait(0.8)

def asst(s, hold=1.4):
    emit("⏺ " + WHT + s + RST + "\r\n"); wait(max(hold, 0.04*len(s)))

def tool(call, result):
    wait(0.4)
    emit(GRN + "⏺ " + RST + WHT + BLD + call + RST + "\r\n"); wait(0.5)
    emit(DIM + "  ⎿  " + result + RST + "\r\n"); wait(0.7)

def code(lines, mark=None):
    for ln in lines:
        s = DIM + "     " + ln + RST
        if mark:
            for tok, col in mark:
                s = s.replace(tok, col + tok + DIM)
        emit(s + "\r\n"); wait(0.08)

def whisper_box(title_lines, body_render, bar=ORG):
    blank(1)
    emit(bar + "  ┃ " + RST + bar + BLD + title_lines[0] + RST + "\r\n"); wait(0.6)
    for tl in title_lines[1:]:
        emit(bar + "  ┃ " + RST + DIM + tl + RST + "\r\n"); wait(0.4)
    body_render(bar)
    blank(1, 0.3)

def parse_whisper(path):
    """real hook output → (header, [(loc, rules, wcag, tier)])."""
    lines = [l for l in open(path).read().splitlines() if l.strip()]
    header = lines[0]
    findings = {}
    for l in lines[1:]:
        parts = [p.strip() for p in l.split("·")]
        if len(parts) < 4: continue
        loc, rule, wcag, tier = parts[0], parts[1], parts[2], parts[3]
        findings.setdefault((loc, wcag, tier), []).append(rule)
    return header, findings

# ══ THE AGENTIC LOOP ════════════════════════════════════════════════════════════
clearscreen(); wait(0.3)
line(BLD+CYN+"  the agentic loop"+RST, dt=0.5)
line(DIM+"  your AI writes the bug. the checker catches it before you do — same turn."+RST, dt=0.4)
line(DIM+"  (a Claude Code session · the auto-whisper output is real hook output)"+RST, dt=2.2)
blank(1)

user("add a clickable product card to the storefront grid")
asst("I'll add a ProductCard component.", hold=1.2)
blank(1)
tool("Write(src/ProductCard.tsx)", "Wrote 9 lines")
code(open(CAP+"/before.tsx").read().splitlines(),
     mark=[("<div", ORG), ("onClick", ORG), ("<img", ORG)])
wait(1.4)

# the hook fires, unasked — the hero beat
header, finds = parse_whisper(CAP+"/whisper.txt")
def render_findings(bar):
    for (loc, wcag, tier), rules in finds.items():
        emit(bar + "  ┃ " + RST + "   " + YEL + loc.split("/")[-1] + RST + "  "
             + MAG + " · ".join(rules) + RST + "\r\n"); wait(0.5)
        emit(bar + "  ┃ " + RST + "       " + DIM + wcag + "  " + tier + RST + "\r\n"); wait(0.4)
whisper_box(
    ["PostToolUse · binclusive-a11y  — the checker speaks up, unasked",
     header],
    render_findings)
wait(1.8)

asst("Good catch. A <div onClick> isn't keyboard-operable, and the <img> has no alt.", hold=2.0)
asst("Fixing both — making it a real button and describing the image:", hold=1.6)
blank(1)
tool("Update(src/ProductCard.tsx)", "Updated 3 lines")
line("     " + RED + '-   <div className="card" onClick={() => open(product.id)}>' + RST)
line("     " + GRN + '+   <button type="button" className="card" onClick={() => open(product.id)}>' + RST)
line("     " + RED + '-     <img src={product.image} />' + RST)
line("     " + GRN + '+     <img src={product.image} alt={product.name} />' + RST)
line("     " + RED + "-   </div>" + RST)
line("     " + GRN + "+   </button>" + RST)
wait(1.6)

# hook fires again — clean
def render_clean(bar):
    emit(bar + "  ┃ " + RST + GRN + "✓ no accessibility issues" + RST + DIM + "  — the hook stays silent" + RST + "\r\n"); wait(0.5)
whisper_box(["PostToolUse · binclusive-a11y"], render_clean, bar=GRN)
wait(1.6)

asst("Done. The card is a real <button> now — keyboard- and screen-reader-operable —", hold=1.8)
asst("and the image carries alt text. ", hold=1.6)
wait(1.2)

# close
clearscreen(); wait(0.4); blank(1)
line(BLD+WHT+"  you never saw the bug."+RST, dt=1.8)
line(DIM+"  it was caught and fixed in the same turn it was written — by the model,"+RST, dt=0.5)
line(DIM+"  from the checker's whisper. no separate lint step. no PR comment. no human in the loop."+RST, dt=2.6)
blank(1)
line("  " + DIM + "wired by one install:" + RST + " " + CYN + "PostToolUse hook → npx @binclusive/a11y hook" + RST, dt=3.0)

write_cast(events, W, H)
