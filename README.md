# a11y-checker — review build

A local accessibility checker for React/TSX code, grounded in a real-world audit corpus. It finds accessibility bugs at the source — **including in the design-system components a normal linter is blind to** — and tells you how common each failure is across real audits, with the fix that worked.

> **It runs entirely on your machine. No network, no account, no upload — your code never leaves the laptop.** That's not a privacy policy, it's how it's built: there's nothing to upload. Point it at a private repo with zero hesitation.

This is a private review build. Clone it, point it at any React codebase (yours, ours, Discord's), and see what it finds — no setup, no explanation needed.

> **New here? Start with the [Getting Started](docs/GETTING-STARTED.md) walkthrough.** Zero to your first fix — install, `init`, wire your editor, read a finding, clear it, gate CI.

---

## Try it (≈3 minutes)

Requires **Node ≥ 20** and **pnpm** (or npm).

```bash
pnpm install                          # or: npm install
pnpm scan path/to/any/app/src         # any folder of .tsx files
```

That's the whole thing. It scans every `.tsx` under the folder and prints a coverage report + the findings. Run it on code you know — you'll be able to judge instantly whether each finding is real.

No clone handy? Point it at this repo's own test fixtures: `pnpm scan ./test/fixtures`.

> **No React source?** (A live site, an ASP.NET/Razor app, plain HTML.) The same checker can render a real page in a browser and audit the live DOM — `pnpm scan:url https://www.havas.net`. See **[Auditing HTML & live pages (non-React)](#auditing-html--live-pages-non-react)** below.

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

There's also a **second producer**: a rendered-DOM collector that drives a real browser to a URL and runs axe-core against the live page — same corpus, same WCAG, same enforcement gate, no source required. That's the next section.

---

## Auditing HTML & live pages (non-React)

The scan above works on `.tsx` source. But not every page *has* React source on disk — a deployed customer site, an ASP.NET/Razor app, a plain HTML/Bootstrap/jQuery page. For those, point the checker at the **rendered page** instead of the source:

```bash
pnpm exec playwright install chromium   # one-time: the browser the render path drives
```

```bash
pnpm scan:url https://www.havas.net     # a deployed site (a real customer)
pnpm scan:url http://localhost:5000     # your local dev server
pnpm scan:url ./wwwroot/index.html      # a local static .html file (bare path works)
```

`<target>` takes an `http(s)://` URL, a `file://` URL, or a **bare local path** (auto-converted to `file://`). Under the hood it renders the page in real Chromium (via Playwright), runs **axe-core** against the live DOM, then flows every finding through the *same* corpus / WCAG / enforcement machinery as the source scan — so a contrast bug on havas.net comes back tiered and gated exactly like a missing label in your `.tsx`.

This is the source-less path — one command audits any live site, React or not.

- **Templates need a running server.** A server-side template (`.cshtml` Razor, `.erb`, etc.) is **not** valid standalone HTML — it's `@`-directives, loops, interpolation — so `file://` can't render it. Point `check-url` at the **running app** (`localhost`) for templates. Only plain `.html` files render directly via `file://`.
- **It catches what static analysis can't.** A real browser render surfaces categories the `.tsx` scan and even headless DOMs (jsdom) are blind to — notably **color-contrast (WCAG 1.4.3)**, computed ARIA roles, and layout-dependent rules.
- **Honest edge:** the seed corpus snapshot currently covers ~10 success criteria and does **not** yet include some SCs this path surfaces (e.g. 1.4.3 contrast, 1.4.1, 2.4.4). Those findings still appear — the render catches them regardless — but they roll up as tier `UNKNOWN` (no corpus fix text) until the corpus is extended.

The full walkthrough — install once, read the output, the `(rendered-DOM / axe)` provenance tag — is in **`docs/AUDIT-URL.md`**.

---

## Dig deeper

| If you want… | Open / read |
|---|---|
| **Adopt it with your own design system** | **`WALKTHROUGH.md`** |
| **Audit a live URL or HTML page (non-React)** | **`docs/AUDIT-URL.md`** |
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
