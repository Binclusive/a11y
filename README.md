# a11y-checker — review build

A local accessibility checker for React/TSX code, grounded in a real-world audit corpus. It finds accessibility bugs at the source — **including in the design-system components a normal linter is blind to** — and tells you how common each failure is across real audits, with the fix that worked.

> **It runs entirely on your machine. No network, no account, no upload — your code never leaves the laptop.** That's not a privacy policy, it's how it's built: there's nothing to upload. Point it at a private repo with zero hesitation.

This is a private review build. Clone it, point it at any React codebase (yours, ours, Discord's), and see what it finds — no setup, no explanation needed.

---

## Try it (≈3 minutes)

Requires **Node ≥ 20** and **pnpm** (or npm).

```bash
pnpm install                          # or: npm install
pnpm scan path/to/any/app/src         # any folder of .tsx files
```

That's the whole thing. It scans every `.tsx` under the folder and prints a coverage report + the findings. Run it on code you know — you'll be able to judge instantly whether each finding is real.

No clone handy? Point it at this repo's own test fixtures: `pnpm scan ./test/fixtures`.

> **Using your own design system?** (Almost everyone is.) A cold scan leaves most of your components in `declare` — *that's expected, not a failure.* To turn on its best trick (finding bugs *inside* your own components), it needs to know which of your components are buttons, inputs, etc. You don't write that by hand:
>
> ```bash
> pnpm a11y-checker init --suggest    # scaffolds the config for you
> ```
>
> It guesses a host for each of your design-system primitives, flags the uncertain ones with `⚠`, and leaves composites alone — so adoption is a **~2-minute review**, not hand-written config. Full on-ramp: **[WALKTHROUGH.md](WALKTHROUGH.md)** — read it before judging a cold run.

---

## What you'll see

```
a11y coverage:
  checked  70   — elements we inspected (findings come from here)
  trusted  60   — from a known-accessible design system — the library handles these
  declare  702  — unrecognized; declare in binclusive.json to inspect them

components/.../AddIntegrationModal.tsx
  AddIntegrationModal.tsx:276
    rule:   enforce/input-no-name  [block]  (call-site content check)
    wcag:   1.3.1, 3.3.2
    corpus: [VERY COMMON] SC 1.3.1 — 22/26 orgs
    fix:    Associate every form field with a <label> via id (not placeholder-only)...

91 finding(s)   VERY COMMON: 87  |  COMMON: 4
enforcement: 91 blocking · 0 warning
```

- **coverage is honest.** Most of a design-system app is *trusted* library components — nothing to flag there, and that's correct, not blindness. The number that matters is "did it find the real bugs," not "what % did it inspect."
- **each finding carries real-world weight** — its WCAG criterion, how widespread it is across our audits (`X/26 orgs`), and the representative fix.
- **`(call-site content check)`** marks findings that reach *trusted* components a normal linter skips. That's the recall win — "trusted" stops being false reassurance.

> **About the exit code:** `scan` exits non-zero when it finds *blocking* issues, so it can gate a CI build. If your run ends with `Command failed with exit code 1`, that's **not** an error — it means it found something. Read the report above it.

---

## What is this, in 30 seconds

Two passes + one corpus:

1. the normal structural lint (`eslint-plugin-jsx-a11y`) over a resolved component map, **plus**
2. a **content check at the call site** that catches bugs hiding inside "trusted" library components (an icon-only button with no name, an input with no label), **plus**
3. every finding **matched to a corpus** of real Binclusive audit failures — so it says not just *that* it's wrong, but *how common* it is in the wild and the fix that worked.

A generic linter can't do 2 or 3. The deeper story (and why the corpus is a moat) is in `docs/`.

---

## Dig deeper

| If you want… | Open / read |
|---|---|
| **Adopt it with your own design system** | **`WALKTHROUGH.md`** |
| The pitch + the moat, with numbers | `docs/decks/numbers.html` |
| Real findings on real OSS projects | `docs/decks/showcase.html` |
| How the machine works, conceptually | `docs/decks/engineering.html` |
| How it's built — the craft | `docs/decks/engineering-deep.html` |
| **The code map — which file does what** | `docs/ARCHITECTURE.md` |
| **The questions you're about to ask** | `FAQ.md` |

The decks are self-contained HTML — open in a browser, arrow keys to navigate, `O` for contents.

---

## Kick the tires

```bash
pnpm test        # 224 tests, all green
pnpm typecheck   # clean
```

Editor surfaces (an MCP server + a Claude Code auto-whisper hook that fixes a11y as the AI writes) are in `plugin/` — `pnpm mcp` starts the local MCP server. The CLI above is the fastest way to feel what it does.

---

*Structure note: this is the `a11y-checker` package extracted to run standalone. Where `docs/ARCHITECTURE.md` says `packages/a11y-checker/src/…`, in this repo it's just `src/…`.*
