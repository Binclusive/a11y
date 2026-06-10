# Help and descriptions

`@effect/cli` generates the `--help` / `-h` output, `--version`, shell completions, and a
`--wizard` flow automatically — you never write a help printer. What you *do* control is the
**description text** attached to commands, options, and args, and (via `CliConfig`) whether
built-in options appear and how usage is rendered. This doc covers adding descriptions and
tuning help generation; the runtime that prints them is in [running.md](./running.md).

## Approaches

### Describe a command

**When to use:** every command — the description shows in its own `--help` and in the parent's
`COMMANDS` list.

**Pattern:**

```typescript
import { Command, Options } from "@effect/cli"

const check = Command.make("check", { json: Options.boolean("json") }).pipe(
  Command.withDescription("Run the accessibility check and report findings")
)

// withDescription also accepts a structured HelpDoc instead of a plain string:
import { HelpDoc } from "@effect/cli"
const init = Command.make("init", {}).pipe(
  Command.withDescription(HelpDoc.p("Scaffold a config file in the current directory"))
)
```

### Describe an option or arg

**When to use:** any flag/positional whose purpose is not obvious from its name.

**Pattern:**

```typescript
import { Args, Options } from "@effect/cli"

const speed = Options.integer("speed").pipe(
  Options.withDescription("Speed in knots"),
  Options.withDefault(10)
)

const name = Args.text({ name: "name" }).pipe(
  Args.withDescription("The name of the ship")
)
```

### Built-in `--help`, `--version`, completions, wizard

**When to use:** they are automatic — do nothing. You only need to know they exist and how to
hide them.

**Pattern:**

```typescript
// Given any command run with Command.run({ name, version }), these work for free:
//   tool --help            tool -h            (full help doc)
//   tool <sub> --help      (per-subcommand help)
//   tool --version         (prints the version string passed to Command.run)
//   tool --completions bash|zsh|fish|sh    (prints a completion script)
//   tool --wizard          (interactive command builder)
```

The version printed is the `version` field given to `Command.run` (see [running.md](./running.md)).

### Hide built-in options / tune usage rendering

**When to use:** you want cleaner help output (e.g. omit `--completions`/`--wizard`), or
case-sensitive parsing.

**Pattern:**

```typescript
import { CliConfig } from "@effect/cli"
import { Effect } from "effect"

// Provide a CliConfig layer; defaults shown in comments.
const ConfigLive = CliConfig.layer({
  showBuiltIns: false,   // default true — hide --completions/--wizard/etc. from help
  showTypes: true,       // default true — show the value type in usage
  showAllNames: true,    // default true — show every alias of an option in usage
  isCaseSensitive: false,// default false
  autoCorrectLimit: 2,   // default 2 — Levenshtein distance for "did you mean" suggestions
  finalCheckBuiltIn: false // default false
})

// Merge ConfigLive into the layer you provide before running (see running.md).
cli(process.argv).pipe(Effect.provide(ConfigLive))
```

## Decision guide

| Goal | Mechanism |
|---|---|
| Document a command | `Command.withDescription` |
| Document a flag | `Options.withDescription` |
| Document a positional | `Args.withDescription` |
| Show version | pass `version` to `Command.run`; `--version` is automatic |
| Show help | automatic `--help` / `-h`; nothing to wire |
| Hide completions/wizard from help | `CliConfig.layer({ showBuiltIns: false })` |
| Case-sensitive parsing | `CliConfig.layer({ isCaseSensitive: true })` |

## Rules

- You never implement `--help`/`--version`/completions yourself — they are built-in options
  injected by `Command.run`. Declaring your own `help`/`version` option collides with them.
- `withDescription` is available on `Command`, `Options`, and `Args` — all three accept a
  `string` or a `HelpDoc`.
- `CliConfig` is provided as a `Layer` (or `Context.Tag`); without one, `defaultConfig` applies.
- `--version` prints exactly the `version` string passed to `Command.run` — keep it in sync
  with `package.json` yourself; the framework does not read `package.json`.

## Anti-patterns

| Don't do this | Why it breaks |
|---|---|
| Declaring `Options.boolean("help")` | Collides with the built-in `-h, --help` |
| Declaring `Options.boolean("version")` | Collides with the built-in `--version` |
| Hardcoding a help string in the handler | Help is generated; write descriptions instead |
| Expecting `--version` to read `package.json` | It echoes the literal `version` arg to `Command.run` |

## See also

- [running.md](./running.md) — `Command.run` injects the built-in options and the version
- [command.md](./command.md) — where `withDescription` is attached
- [subcommands.md](./subcommands.md) — subcommand descriptions populate the `COMMANDS` list
