# demo/ — the a11y-checker demo

Two ways to drive the same walkthrough:

| Path | What it is | When |
|---|---|---|
| **`scenario.json` + `demo-kit`** | The demo authored as **data**: one spec drives a self-verifying lint, a live walk-through, and a recorded video. | Default. Author/maintain the demo here. |
| `demo.sh` | The legacy hand-driven presenter script. Still works. | **Superseded by `demo-kit play`** — kept for reference. |
| `TUTORIAL.md` | A copy-pasteable narrative of the same flow. | Reading, not driving. |

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
pnpm demo:lint     # tsx demo/demo-kit.ts lint   demo/scenario.json
pnpm demo:play     # tsx demo/demo-kit.ts play   demo/scenario.json
pnpm demo:record   # tsx demo/demo-kit.ts record demo/scenario.json
```

| Verb | What it does |
|---|---|
| **`lint`** | Runs every step against the isolated fixture, captures stdout+stderr+exit, evaluates `expect`, prints a `PASS`/`FAIL` line per step, and **exits non-zero if any assertion fails**. This is the linchpin: it catches a command that silently errors (e.g. a bare `scan` → `command not found`) or output that no longer matches. |
| **`play`** | Drives the demo live in the current TTY: prints `say`, types `run` char-by-char at `typingSpeed`, executes, then **waits until `expect` is satisfied** (polls with a timeout — not a blind sleep) before pausing `read` seconds and advancing. `--manual` waits for Enter between steps (human presenter); default auto-advances (agent/CI). |
| **`record`** | **Regenerates `demo.tape` from the scenario** (theme/typingSpeed/size from `terminal`, a `Type`/`Enter` per step, `Sleep` derived from `read` + a scan allowance, `say` lines as on-screen comments, `shellInit` sourced in a `Hide` block) and runs `vhs` to write `demo.gif` + `demo.mp4`. Regenerating from the spec is the point — the video can't drift from the live demo. (VHS's headless Chrome needs loopback to ttyd; a sandbox can block that. The tape regenerates regardless; re-run unsandboxed to render.) `demo.tape` is generated — do not hand-edit it. |

### The workflow

```
author scenario.json  →  pnpm demo:lint   (prove it works)
                      →  pnpm demo:play    (drive it live)   OR
                      →  pnpm demo:record  (render a GIF/MP4)
```

`lint` is your CI gate: if a CLI subcommand changes, an output string drifts, or a
step starts erroring, `lint` goes red before anyone watches a demo that lies.
