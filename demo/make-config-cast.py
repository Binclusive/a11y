#!/usr/bin/env python3
"""
make-config-cast.py — synthesize demo/config.cast: binclusive.json, explained.

A guided tour of the one committed config file: what init writes, the enforcement
lever (block vs warn), the components escape-hatch + `init --suggest` scaffold,
the injectsChildren/ignore hatches, and team `learn` rules. Fields and meanings
are from src/contract.ts; values/scaffold/learn output are captured from a real
run on calcom/cal.com apps/web (see record-config.sh).

Why synthesize vs `asciinema rec`: headless shells have no TTY and the recorder
won't honor real sleeps. Output: asciinema v2 cast on stdout.
"""
import json, sys, os
from castkit import *

CAP = os.environ.get("CAP", "/tmp/cfg")
W, H = 100, 36

def part(n, title, total=6):
    clearscreen(); wait(0.3)
    emit(NUM + BLD + f"  PART {n}/{total}" + RST + "  " + WHT + BLD + title + RST + "\r\n")
    emit(DIM + "  " + "─" * (len(title) + 14) + RST + "\r\n")
    blank(1); wait(0.7)

def jline(s, note=None, dt=0.18):
    """a JSON line (already colored) + optional dim right-margin annotation."""
    pad = max(2, 52 - len(_visible(s)))
    suffix = (" " * pad + DIM + "← " + note + RST) if note else ""
    emit("  " + s + suffix + "\r\n"); wait(dt)

def _visible(s):
    import re
    return re.sub(r"\x1b\[[0-9;]*m", "", s)

def raw(path, indent="  ", dt=0.05, recolor=None):
    for ln in open(path).read().splitlines():
        emit(indent + (recolor(ln) if recolor else ln) + "\r\n"); wait(dt)

def k(key, val, q=True):
    v = (STR + f'"{val}"' + RST) if q else (YEL + str(val) + RST)
    return KEY + f'"{key}"' + RST + ": " + v

def c_suggest(ln):
    if "suggested" in ln:
        import re
        return WHT + re.sub(r"\b(\d+)\b", YEL + BLD + r"\1" + RST + WHT, ln, count=1) + RST
    if "→" in ln:
        name, rest = ln.split("→", 1)
        if "⚠" in rest:
            host, note = rest.split("⚠", 1)
            return "  " + WHT + name.strip().ljust(24) + RST + DIM + "→ " + STR + host.strip() + RST \
                   + YEL + "  ⚠ " + RST + DIM + note.strip() + RST
        host = rest.replace("✓", "").strip()
        return "  " + WHT + name.strip().ljust(24) + RST + DIM + "→ " + STR + host + RST + GRN + "  ✓" + RST
    if "more" in ln: return DIM + ln + RST
    return DIM + ln + RST

def c_learned(ln):
    s = ln
    for key in ('"id"', '"rule"', '"wcag"', '"fix"', '"source"'):
        s = s.replace(key, KEY + key + RST)
    return DIM + s + RST

# load real captured values --------------------------------------------------------
base = json.load(open(CAP + "/base.json"))
st = base["stack"]; enf = base["enforcement"]
blk = ", ".join(f'"{x}"' for x in enf["block"])
wrn = ", ".join(f'"{x}"' for x in enf["warn"][:4]) + ", …"

# ══ THE CONFIG TOUR ═════════════════════════════════════════════════════════════
clearscreen(); wait(0.3)
line(BLD + CYN + "  binclusive.json — your accessibility contract, explained" + RST); wait(0.6)
line(DIM + "  one committed file · no secrets, ever · the lever between 'noisy' and 'enforced'" + RST); wait(2.6)

# 1 — what init writes
part(1, "What init writes")
vo("  You don't hand-author this. init detects your stack and writes the base contract:")
blank(1)
line("  " + DIM + "{" + RST)
jline(k("version", 1, q=False), "schema version")
jline(KEY + '"stack"' + RST + ": {", "auto-detected — never hand-write")
emit("    " + k("framework", st["framework"]) + ", " + k("router", st["router"]) + ", " + k("designSystem", st["designSystem"]) + ", " + k("language", st["language"]) + "\r\n"); wait(0.3)
line("  " + DIM + "  }," + RST)
jline(KEY + '"enforcement"' + RST + ": { " + DIM + "block / warn" + RST + " },", "the lever you own — Part 2")
jline(KEY + '"learned"' + RST + ": []", "your team's rules — Part 5")
jline(KEY + '"components"' + RST + ": { … }", "your design system — Part 3")
line("  " + DIM + "}" + RST)
blank(1); wait(1.4)
vo("  Commit it. Your whole team — and every AI tool — reads the same contract.")
wait(1.6)

# 2 — enforcement: the lever
part(2, "enforcement — what fails the build")
vo("  Two buckets of WCAG criteria. This is the only policy dial you turn:")
blank(1)
line("  " + KEY + '"enforcement"' + RST + ": {")
jline(KEY + '"block"' + RST + ": [" + STR + blk + RST + "],", RED + "FAIL the build (CI red)" + DIM)
jline(KEY + '"warn"' + RST + ":  [" + STR + wrn + RST + "]", YEL + "surface, don't block" + DIM)
line("  }")
blank(1); wait(1.8)
vo("  Want missing alt-text to block too? Move one criterion across:")
blank(1)
line("  " + RED + '-   "warn":  ["1.1.1", …]' + RST)
line("  " + GRN + '+   "block": ["1.1.1", "1.3.1", "4.1.2", "2.4.4"]' + RST + DIM + "   ← 1.1.1 now stops the build" + RST)
blank(1); wait(2.0)
vo("  A criterion lives in at most one bucket — if you list it in both, block wins.")
wait(1.8)

# 3 — components: the escape hatch + --suggest
part(3, "components — see through your design system")
vo("  jsx-a11y only understands host tags (button, input, a). Your <Button> is opaque —")
vo("  so you map each primitive to the host it renders. You don't write 30 of these by hand:")
blank(1)
typed("npx @binclusive/a11y init --suggest")
raw(CAP + "/suggest.txt", recolor=c_suggest, dt=0.04)
blank(1); wait(1.6)
vo("  It guessed a host for every primitive — " + GRN + "✓" + DIM + " confident, " + YEL + "⚠" + DIM + " review the uncertain.")
vo("  Composites with no single host stay in declare. A 2-minute review, not hand-config.")
wait(1.4)
clearscreen(); wait(0.3)
line(WHT + BLD + "  the written components map" + RST + DIM + "  (your word overrides inference)" + RST); blank(1); wait(0.6)
line("  " + KEY + '"components"' + RST + ": {")
raw(CAP + "/components.txt", indent="  ", dt=0.06,
    recolor=lambda l: (KEY + l + RST) if l.strip().startswith('"') else DIM + l + RST)
line("  }")
blank(1); wait(2.2)

# 4 — escape hatches
part(4, "Two escape hatches for the edge cases")
vo("  When auto-detection can't be right, you get the final word:")
blank(1)
line("  " + KEY + '"injectsChildren"' + RST + ": [" + STR + '"Trans"' + RST + ", " + STR + '"FormattedMessage"' + RST + "],"
     + DIM + "   ← i18n text helpers" + RST)
line("     " + DIM + "↳ " + WHT + "Trans" + DIM + " (react-i18next) · " + WHT + "FormattedMessage" + DIM + " (react-intl) inject text at RUNTIME." + RST)
line("       " + DIM + "Trans is built-in — declare " + WHT + "your own" + DIM + " Trans-like wrappers so kids aren't flagged 'empty'." + RST)
blank(1); wait(2.2)
line("  " + KEY + '"ignore"' + RST + ": [" + STR + '"**/*.stories.tsx"' + RST + ", " + STR + '"jsx-a11y/no-autofocus"' + RST + "]")
line("     " + DIM + "↳ a file glob drops the file · a rule id drops that rule everywhere" + RST)
blank(1); wait(2.4)
vo("  Every hatch is optional and parsed leniently — one bad line is dropped, never the whole file.")
wait(1.8)

# 5 — learned rules
part(5, "learned — teach it your team's rules")
vo("  Record a rule once; it rides into every AI turn via the generated AGENTS.md / CLAUDE.md.")
blank(1)
typed('npx @binclusive/a11y learn "Icon-only buttons must have an aria-label" \\', post=0.2)
emit(GRN + "  " + RST + DIM + "    --wcag 4.1.2 --fix \"Add aria-label to icon-only controls\"" + RST + "\r\n"); wait(0.6)
raw(CAP + "/learn.txt", indent="  ", dt=0.08,
    recolor=lambda l: (GRN + l + RST) if "learned" in l else DIM + l + RST)
blank(1); wait(1.2)
vo("  …appended to learned[] as structured data:")
blank(1)
raw(CAP + "/learned.txt", indent="  ", dt=0.05, recolor=c_learned)
blank(1); wait(2.4)

# 6 — re-run safe
part(6, "Safe to re-run · safe to commit")
vo("  Re-running init refreshes only the auto-detected " + WHT + "stack" + DIM + ".")
vo("  Your " + WHT + "enforcement" + DIM + ", " + WHT + "components" + DIM + ", " + WHT + "learned" + DIM + ", and hatches are preserved byte-for-byte.")
blank(1); wait(1.4)
line("  " + GRN + "✓" + RST + DIM + "  no secret or API key ever lands here — it's plain config" + RST)
line("  " + GRN + "✓" + RST + DIM + "  committed to your git · read by the CLI, the MCP server, and your agent" + RST)
line("  " + GRN + "✓" + RST + DIM + "  nothing leaves the machine" + RST)
blank(1); wait(2.0)
clearscreen(); wait(0.4); blank(1)
line(BLD + WHT + "  stack · enforcement · components · injectsChildren · ignore · learned" + RST); wait(1.8)
line(DIM + "  one file. detected for you, tuned by you, committed with your code." + RST); wait(1.2)
blank(1)
line("  " + DIM + "full field reference:" + RST + " " + CYN + "src/contract.ts" + RST + DIM + "  ·  " + RST + CYN + "docs/GETTING-STARTED.md" + RST)
wait(3.0)

write_cast(events, W, H)
