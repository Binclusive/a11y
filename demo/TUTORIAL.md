# a11y-checker — live demo & tutorial

A copy-pasteable walkthrough of the a11y-checker, mirroring `demo/demo.sh`.
Two acts: a tiny sample app as the on-ramp, then real OSS apps as the
credibility close.

## What the checker does (30 seconds)

- Resolves each imported component to an HTML host (declaration → registry →
  tracing the package's source on disk). Components it can't resolve land in
  `declare` — an honest "I can't see these."
- Runs **two** passes: jsx-a11y **structural** checks, plus a corpus-driven
  **content** check (`enforce/*`) that catches missing accessible names even
  inside opaque components, once their host is known.
- `react-router` / Remix `Link` / `NavLink` are recognized as link controls
  with **zero config**.
- A scan **exits non-zero when it finds blocking findings** — that's the CI
  gate working, not an error.

## Prerequisites

- Node 18+ and `pnpm` (the checker runs via `pnpm exec tsx ./src/cli.ts`).
- `jq` is nice-to-have for the JSON step (the script falls back to `tail`).
- Run everything from the **repo root** (`a11y-checker-plugin/`).

In this tutorial, `a11y` is shorthand for the real command:

```sh
a11y() { pnpm exec tsx ./src/cli.ts "$@"; }   # paste once into your shell
```

---

## Act 1 — the sample app (on-ramp)

The sample app `demo/sample-app/` is `acme-app`: a tiny React app with
intentional a11y bugs. Its design system `@acme/ui` is **declared in
package.json but never installed** — that's deliberate, so you can watch the
checker stay honest about what it can't see, then watch recall jump once you
declare your primitives.

### Step 1 — cold scan (zero config)

```sh
a11y scan demo/sample-app/src
```

**Expect: 3 blocking findings, exit code 1.**

| where | rule | why |
|---|---|---|
| `pages/Gallery.tsx:12` | `jsx-a11y/alt-text` | raw `<img>` with no `alt` |
| `pages/Gallery.tsx:15` | `jsx-a11y/anchor-is-valid` | raw `<a href="#">` goes nowhere |
| `components/Nav.tsx:18` | `enforce/link-no-name` | icon-only `<Link to="/settings"><GearIcon/></Link>` |

Coverage line reports `declare 9` and prints, verbatim:

```
note: 9 component(s) are opaque because their package isn't resolved on disk
(@acme/ui, react-router) — install dependencies for deeper tracing.
```

**Why it matters:**
- The intrinsic bugs were caught with **zero config**.
- The icon-only **react-router `Link` is flagged on the COLD scan** — link
  controls are recognized by name, no declaration needed.
- `@acme/ui` isn't on disk, so its `Button` / `IconButton` / `TextField` land
  in `declare`, and the checker **says so** instead of guessing.

### Step 2 — `init` (detect the stack, write policy)

```sh
a11y init demo/sample-app
```

**Expect:**
```
stack:       react · @acme/ui · ts
enforcement: block 1.3.1, 4.1.2, 2.4.4
wrote:       binclusive.json
block:       AGENTS.md
block:       CLAUDE.md
```

`init` writes a starter `binclusive.json` (and a managed block in
`AGENTS.md` / `CLAUDE.md`). These files are **git-ignored** in the sample app —
they're produced live and never committed.

### Step 3 — declare your 3 primitives

`init`'s config has an empty `components` map. The demo copies a pristine,
post-declare config over it so the "teach it your design system" step reads
cleanly:

```sh
cp demo/sample-app/binclusive.declared.json demo/sample-app/binclusive.json
cat demo/sample-app/binclusive.json
```

The three lines that matter (note: `components` is a **top-level** key in
`binclusive.json`, not nested under `declarations`):

```json
"components": {
  "Button": "button",
  "IconButton": "button",
  "TextField": "input"
}
```

### Step 4 — rescan (the recall win)

```sh
a11y scan demo/sample-app/src
```

**Expect: 5 blocking findings** (up from 3). The two NEW findings were hidden
inside `@acme/ui` and only surfaced after declaring:

| where | rule | why |
|---|---|---|
| `pages/SettingsForm.tsx:20` | `enforce/input-no-name` | `<TextField placeholder="Email"/>` — placeholder is **not** a label |
| `pages/SettingsForm.tsx:27` | `enforce/button-no-name` | icon-only `<IconButton><TrashIcon/></IconButton>` |

Coverage moves too: `checked 0 → 3`, `declare 9 → 6` (the 3 declared `@acme/ui`
primitives moved from "can't see" to "checked").

**Why it matters:** declaring 3 primitives turned a blind spot into 2 extra
real bugs — **content** the app passes into otherwise-opaque components. And it
stays precise: the labelled `Button`, the `alt`'d `<img>`, and the
`<Link to>text</Link>` are **not** flagged. Zero false positives.

> Cold **3** → rescan **5** findings. That delta is the whole point of Act 1.

### Step 5 — `--json` (CI-ready)

```sh
a11y check demo/sample-app/src --json | jq '.summary'
```

(no `jq`? use `... --json | tail -n 12`.)

```json
{
  "findings": 5,
  "blocking": 5,
  "warning": 0,
  "byTier": { "very-common": 4, "common": 1, "occasional": 0, "unknown": 0 }
}
```

Report keys: `tool, root, filesScanned, coverage, findings, summary`.
`summary.blocking` is your build gate.

### Clean up

The generated config is git-ignored, but to reset to a pristine state:

```sh
rm -f demo/sample-app/binclusive.json demo/sample-app/AGENTS.md demo/sample-app/CLAUDE.md
```

---

## Act 2 — real OSS (credibility close)

### Live OSS scan — shadcn-ui/taxonomy

Scan a real, recognizable app: shadcn's own **Taxonomy** (Next.js + Radix).
The demo resolves the target dir in priority order, so it's instant now and
reproducible later:

1. reuse the already-cloned experiment cache
   `experiments/stack-matrix/.cache/shadcn-ui__taxonomy` if present;
2. else clone a shallow copy into the git-ignored `demo/.cache/`:
   `git clone --depth 1 https://github.com/shadcn-ui/taxonomy demo/.cache/shadcn-ui__taxonomy`;
3. if the clone fails (no network), skip straight to the matrix step below.

Then scan the **repo root** (its `.tsx` spans `app/` and `components/`):

```sh
a11y scan experiments/stack-matrix/.cache/shadcn-ui__taxonomy
```

**Expect: 14 blocking findings**, zero config, zero false positives. Breakdown:

| count | rule |
|---:|---|
| 9 | `jsx-a11y/heading-has-content` (empty headings) |
| 3 | `jsx-a11y/anchor-is-valid` |
| 1 | `jsx-a11y/anchor-has-content` |
| 1 | `enforce/input-no-name` |

Radix's **104 components read as `trusted`** — the 14 findings are app-owned
content bugs in a polished, popular app, not framework noise. That's the
credibility number: 14 real issues a normal lint run never surfaces.

### The cross-stack experiment

```sh
sed -n '1,30p' experiments/stack-matrix/REPORT.md
```

**20 OSS React apps × 8 design systems × 4 frameworks**, all cold-scanned out
of the box (no `init`, no manual declarations). A few headline rows:

| repo | framework | designSystem | findings | topRule |
|---|---|---|---:|---|
| jolbol1/jolly-ui | next | reactAria | 315 | `enforce/input-no-name` |
| Supernova3339/changerawr | next | headlessui | 142 | `enforce/button-no-name` |
| DarkInventor/easy-ui | next | radix | 57 | `enforce/button-no-name` |

**Why it matters:**
- Precision **holds** across stacks — the zero-FP discipline travels.
- The big clusters are **real recall, not noise**: `enforce/input-no-name` and
  `enforce/button-no-name` top the list — exactly the opaque-component content
  bugs Act 1 demonstrated, now found at scale.

---

## How to run the live demo

> **Superseded by `demo-kit play`.** This same flow is now authored as data in
> `demo/scenario.json` and driven by `pnpm demo:play` (live), `pnpm demo:lint`
> (self-verifying), and `pnpm demo:record` (GIF/MP4). See `demo/README.md`. The
> hand-driven `demo.sh` below is kept for reference.

The presenter script types each command for you and waits for Enter:

```sh
bash demo/demo.sh
```

- Press **Enter** to advance each step.
- Typing speed: `DEMO_SPEED=0.02 bash demo/demo.sh` (faster) or
  `DEMO_SPEED=0.06` (slower). Default is `0.04` s/char.
- It's **idempotent**: it removes any live-generated
  `binclusive.json` / `AGENTS.md` / `CLAUDE.md` at start and on exit.

### Driving it from tmux

Run it in a tmux pane and advance steps by sending Enter into that pane:

```sh
tmux new-session -d -s demo 'bash demo/demo.sh'
tmux attach -t demo
# from another shell, to advance a step:
tmux send-keys -t demo Enter
```

---

## Quick reference — the on-screen commands, in order

```sh
a11y scan demo/sample-app/src                                  # cold: 3 findings
a11y init demo/sample-app                                      # detect stack, write policy
cp demo/sample-app/binclusive.declared.json demo/sample-app/binclusive.json
cat demo/sample-app/binclusive.json                            # the 3 declared primitives
a11y scan demo/sample-app/src                                  # rescan: 5 findings (recall win)
a11y check demo/sample-app/src --json | jq '.summary'          # CI-ready
a11y scan experiments/stack-matrix/.cache/shadcn-ui__taxonomy  # real OSS: 14 findings
sed -n '1,30p' experiments/stack-matrix/REPORT.md              # 20 repos × 8 systems
```
