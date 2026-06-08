# demo/ — the a11y-checker demo

## The headline cut: `scenario.killer.json`

**The 60-second pitch.** On `DarkInventor/easy-ui` — a real shadcn kit people
install — `eslint-plugin-jsx-a11y` (recommended config) passes the icon-only
share button **clean (0 problems)**, while a11y-checker flags it
`enforce/button-no-name` (WCAG 4.1.2) with a `fix:` line. Then it scales: across
easy-ui's components, **every** icon-only button is nameless, and eslint passed
every one. Real kit, real bug, the linter everyone trusts walks right past it.

```sh
pnpm demo:lint   demo/scenario.killer.json   # prove it (eslint misses, checker catches)
pnpm demo:record demo/scenario.killer.json   # render demo/killer.gif + killer.mp4
```

A hidden `setup` step clones easy-ui into `demo/.cache/easy-ui` (gitignored) on
first run — preferring a local copy under `experiments/stack-matrix/.cache`,
falling back to `git clone`. The checker only resolves easy-ui's shadcn
`<Button>` to a real `<button>` when it scans **inside** the clone (the repo's
`tsconfig.json` + `components/ui/button.tsx` must be present), so the scan always
targets a directory within the clone.

---

Demos in this directory:

| Demo | What it is | When |
|---|---|---|
| **`scenario.killer.json`** | The headline cut above: eslint-clean vs a11y-checker on real shadcn code. | Lead with this. |
| `scenario.json` | The full **workflow** demo: declare your design system on a sample app, recover hidden findings, close on real OSS code. | The on-ramp / how-it-works walk-through. |
| `demo.sh` | The legacy hand-driven presenter script. Still works. | **Superseded by `demo-kit play`** — kept for reference. |
| `TUTORIAL.md` | A copy-pasteable narrative of the workflow demo. | Reading, not driving. |

Both `.json` scenarios are authored as **data** and driven by the same
`demo-kit` (lint / play / record); the schema below applies to both.

---

## Reusable: `scenario.json` + `demo-kit`

Author a terminal demo **once, as data**, and get three things from the one spec —
so the live demo and the recorded video can never drift, and every step is
**proven before it is shown**.

### The schema at a glance

`scenario.schema.json` (JSON Schema, draft 2020-12) defines the contract. Top-level:

| Field | Meaning |
|---|---|
| `name`, `title` | slug + title-card text |
| `terminal` | `width`, `height`, `theme`, `fontSize`, `typingSpeed` (e.g. `"45ms"`), `padding` — presentation knobs (drive VHS `Set` directives) |
| `workdir` | repo-relative cwd for **every** command (default `"."`). Keep it at the repo root: the `a11y` alias uses `pnpm exec`, which needs a workspace `package.json` on the path. |
| `shellInit` | lines sourced before every command (e.g. `source demo/_a11y.sh`); hidden from the screen |
| `isolation` | `{ fixture, as }` — bind a fixture path to an env var (e.g. `$FIX`). See below. |
| `setup` / `teardown` | hidden housekeeping steps |
| `acts[]` | `{ title, steps[] }` — the body of the demo |

A **step** is:

```jsonc
{
  "say": ["dim narration line", "…"],        // printed before the command
  "run": "a11y scan $FIX/src",               // typed on screen + executed
  "expect": {                                 // assertions (the safety net)
    "exit": 1,
    "stdoutContains": ["3 finding(s)", "enforce/link-no-name"],
    "stdoutNotContains": ["ENOENT"],
    "stdoutRegex": "..."
  },
  "read": 4,                                  // seconds to pause after output (pacing)
  "hidden": false                             // run, but don't show on screen
}
```

### Isolation — why a fixture-mutating step can't dirty the repo

`isolation: { "fixture": "demo/sample-app", "as": "FIX" }` binds `$FIX`:

- **`lint`** → `$FIX` points at a **per-run temp copy** of the fixture (outside the
  repo). Mutating steps (`a11y init`, `cp … binclusive.json`) share that one copy
  within the run and are cleaned up after. A background process mutating the real
  `demo/sample-app` can't race the demo, and the demo can't dirty the repo.
- **`play` / `record`** → `$FIX` points at the **real** fixture path, so on-screen
  commands read clean. `play` removes generated files (`binclusive.json`,
  `AGENTS.md`, `CLAUDE.md`) on exit.

### The three verbs

```sh
# Each script forwards its scenario argument to demo-kit; with none, it defaults
# to demo/scenario.json (the workflow demo).
pnpm demo:lint     demo/scenario.killer.json   # tsx demo/demo-kit.ts lint   <scenario>
pnpm demo:play     demo/scenario.killer.json   # tsx demo/demo-kit.ts play   <scenario>
pnpm demo:record   demo/scenario.killer.json   # tsx demo/demo-kit.ts record <scenario>

pnpm demo:lint                                 # no arg → demo/scenario.json
```

| Verb | What it does |
|---|---|
| **`lint`** | Runs every step against the isolated fixture, captures stdout+stderr+exit, evaluates `expect`, prints a `PASS`/`FAIL` line per step, and **exits non-zero if any assertion fails**. This is the linchpin: it catches a command that silently errors (e.g. a bare `scan` → `command not found`) or output that no longer matches. |
| **`play`** | Drives the demo live in the current TTY: prints `say`, types `run` char-by-char at `typingSpeed`, executes, then **waits until `expect` is satisfied** (polls with a timeout — not a blind sleep) before pausing `read` seconds and advancing. `--manual` waits for Enter between steps (human presenter); default auto-advances (agent/CI). |
| **`record`** | **Regenerates `demo.tape` from the scenario** (theme/typingSpeed/size from `terminal`, a `Type`/`Enter` per step, `Sleep` derived from `read` + a scan allowance, `say` lines as on-screen comments, `shellInit` sourced in a `Hide` block) and runs `vhs` to write `demo.gif` + `demo.mp4`. Regenerating from the spec is the point — the video can't drift from the live demo. (VHS's headless Chrome needs loopback to ttyd; a sandbox can block that. The tape regenerates regardless; re-run unsandboxed to render.) `demo.tape` is generated — do not hand-edit it. |

### The workflow

```
author <scenario>.json  →  pnpm demo:lint   <scenario>  (prove it works)
                        →  pnpm demo:play    <scenario>  (drive it live)   OR
                        →  pnpm demo:record  <scenario>  (render a GIF/MP4)
```

`lint` is your CI gate: if a CLI subcommand changes, an output string drifts, or a
step starts erroring, `lint` goes red before anyone watches a demo that lies.
