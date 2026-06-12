#!/usr/bin/env python3
"""
make-tutorial-cast.py — synthesize demo/tutorial.cast: the getting-started how-to,
run against the real calcom/cal.com Turborepo monorepo.

Zero to your first fix: install · init · check · read a finding · fix it · gate CI.
Calm, numbered, follow-along. Authentic bytes are captured from a real run on
apps/web (see record-tutorial.sh); install/CI snippets mirror docs/GETTING-STARTED.md.

Why synthesize instead of `asciinema rec`: headless shells have no TTY and the
recorder won't honor real sleeps, so a recorded GIF races by. Building the cast
directly gives frame-exact pacing. Output: asciinema v2 cast on stdout.
"""
import json, sys, os
from castkit import *

CAP = os.environ.get("CAP", "/tmp/tut")
W, H = 100, 34

def step(n, title, total=6):
    clearscreen(); wait(0.3)
    emit(NUM + BLD + f"  STEP {n}/{total}" + RST + "  " + WHT + BLD + title + RST + "\r\n")
    emit(DIM + "  " + "─" * (len(title) + 14) + RST + "\r\n")
    blank(1); wait(0.7)

# colorizers ---------------------------------------------------------------------
def c_init(ln):
    s = ln
    for k in ("stack:", "enforcement:", "wrote:"):
        if k in s: s = s.replace(k, CYN + k + DIM, 1)
    s = s.replace("next (app router)", WHT + "next (app router)" + DIM)
    s = s.replace("@calcom/ui", YEL + BLD + "@calcom/ui" + RST + DIM)
    return DIM + s + RST
def c_cov(ln):
    if "scanned" in ln: return DIM + ln.replace("scanned 8", "scanned " + WHT + "8" + DIM, 1) + RST
    if "checked" in ln: return DIM + ln.replace("3", GRN + BLD + "3" + RST + DIM, 1) + RST
    if "trusted" in ln: return DIM + ln + RST
    if "declare" in ln: return DIM + ln + RST
    if "finding(s)" in ln: return WHT + BLD + ln + RST
    if "enforcement:" in ln: return DIM + ln.replace("4 blocking", RED + "4 blocking" + DIM) + RST
    return DIM + ln + RST
def c_find(ln):
    if "CancelBooking.tsx:66" in ln and "rule" not in ln: return BLD + WHT + ln + RST
    if "enforce/input-no-name" in ln:
        ln = ln.replace("enforce/input-no-name", MAG + "enforce/input-no-name" + RST + DIM)
        ln = ln.replace("[block]", RED + BLD + "[block]" + RST + DIM)
        ln = ln.replace("(call-site content check)", CYN + BLD + "(call-site content check)" + RST + DIM)
        return DIM + ln + RST
    if "severity:" in ln: return DIM + ln.replace("CRITICAL", RED + BLD + "CRITICAL" + RST + DIM) + RST
    if "corpus:" in ln: return DIM + ln.replace("[VERY COMMON]", YEL + "[VERY COMMON]" + DIM).replace("22/26 orgs", YEL + BLD + "22/26 orgs" + RST + DIM) + RST
    if "fix:" in ln: return GRN + ln + RST
    return DIM + ln + RST

# ══ THE TUTORIAL ════════════════════════════════════════════════════════════════
clearscreen(); wait(0.3)
line(BLD + CYN + "  a11y-checker · getting started" + RST); wait(0.6)
line(DIM + "  zero to your first accessibility fix — on a real monorepo (calcom/cal.com)." + RST)
line(DIM + "  everything runs on your machine. no account. your code never leaves the laptop." + RST); wait(2.8)

# 1 — install
step(1, "Install")
vo("  It's a private npm package plus a Claude Code plugin. Authenticate once:")
blank(1)
block(["@binclusive:registry=https://npm.pkg.github.com",
       "//npm.pkg.github.com/:_authToken=YOUR_GITHUB_TOKEN"], indent="    " + DIM)
emit(RST); blank(1)
emit(DIM + "    # ~/.npmrc — read:packages scope, one time" + RST + "\r\n"); wait(1.4)
typed("npm view @binclusive/a11y version")
line("  " + WHT + "0.1.0" + RST + DIM + "   ✓ resolves — you're in." + RST); wait(1.6)
vo("  Then, in Claude Code:")
typed("/plugin install a11y-checker@binclusive", prompt="")
line("  " + GRN + "✓ installed" + RST + DIM + "   MCP server · auto-whisper hook · grind skill" + RST); wait(2.0)

# 2 — init
step(2, "init — detect the stack, write one contract for the monorepo")
vo("  Point init at your app. It reads the repo and writes the committed contract.")
blank(1)
typed("npx @binclusive/a11y init apps/web")
raw(CAP + "/init.txt", recolor=c_init)
blank(1); wait(1.0)
vo("  Next app-router, TypeScript — and it found your in-repo design system, " + YEL + "@calcom/ui" + DIM + ".")
vo("  " + WHT + "binclusive.json" + DIM + " is yours to commit. That's the whole setup.")
wait(1.8)

# 3 — check (the monorepo win: traces your own UI from disk)
step(3, "check — scan a real flow")
vo("  Audit the booking components. No config beyond init:")
blank(1)
typed("npx @binclusive/a11y check apps/web/components/booking")
raw(CAP + "/coverage.txt", recolor=c_cov)
blank(1); wait(1.4)
vo("  Here's the monorepo win: " + YEL + "@calcom/ui" + DIM + " lives in packages/ui, on disk —")
vo("  so it traces straight through your own components. " + WHT + "4 real findings" + DIM + ", zero declaration.")
vo("  " + DIM + "(trusted = Radix guarantees the structure · declare = name the rest to go deeper)" + RST, hold=2.2)
wait(1.4)

# 4 — read a finding
step(4, "Read a finding")
vo("  Every finding has the same four parts. Take this one — the cancel-booking note:")
blank(1)
raw(CAP + "/finding.txt", recolor=c_find)
blank(1); wait(2.2)
vo("  " + MAG + "rule" + DIM + " what broke   ·   " + WHT + "wcag" + DIM + " the criterion   ·   " + YEL + "corpus" + DIM + " how common in real audits   ·   " + GRN + "fix" + DIM + " what worked")
wait(2.4)

# 5 — fix it
step(5, "Fix it")
vo("  A placeholder is not a name. Give the field a real one — one line:")
blank(1)
line("  " + DIM + "apps/web/components/booking/CancelBooking.tsx" + RST)
line("  " + DIM + "  <TextArea" + RST)
line("  " + GRN + '+   aria-label={t("internal_booking_note_description")}' + RST)
line("  " + DIM + "    rows={3}" + RST)
line("  " + DIM + '    placeholder={t("internal_booking_note_description")} />' + RST)
blank(1); wait(2.2)
typed("npx @binclusive/a11y check apps/web/components/booking")
line("  " + WHT + BLD + "3 finding(s)" + RST + DIM + "   VERY COMMON: 1  |  COMMON: 2" + RST); wait(0.4)
line("  " + GRN + "✓ CancelBooking.tsx:66 — cleared." + RST); wait(2.0)
vo("  Down from 4. That note field now has a name a screen reader can announce.")
wait(1.8)

# 6 — gate CI
step(6, "Gate CI — keep it fixed")
vo("  check exits non-zero while any blocking issue remains — so it fails a build.")
blank(1)
typed("npx @binclusive/a11y check apps/web ; echo \"exit: $?\"")
line("  " + DIM + "…" + RST)
line("  " + RED + "exit: 1" + RST + DIM + "   blocking issues remain — the build stops here." + RST); wait(1.8)
vo("  Drop one line into your pipeline:")
blank(1)
block(["# .github/workflows/a11y.yml",
       "- run: npx @binclusive/a11y check apps/web"], indent="    ", color=BLU)
blank(1); wait(2.0)
vo("  Now the bug can't merge.")
wait(1.6)

# close
clearscreen(); wait(0.4); blank(1)
line(BLD + WHT + "  install · init · check · read · fix · gate" + RST); wait(1.8)
line(DIM + "  one contract for the whole monorepo. everything local. your code never leaves the laptop." + RST); wait(1.4)
blank(1)
line("  " + DIM + "next:" + RST + " " + CYN + "docs/GETTING-STARTED.md" + RST + DIM + "  ·  " + RST + CYN + "init --suggest" + RST + DIM + " scaffolds the declare map for any opaque deps" + RST)
wait(3.0)

write_cast(events, W, H)
