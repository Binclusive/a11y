# Subcommands (command groups)

A CLI with multiple verbs — `tool check`, `tool init`, `tool gen` — is a root `Command` with
child commands attached via `Command.withSubcommands`. The root holds the program's global
options; each child is a full `Command` with its own options, args, and handler. Children can
read the parent's parsed config because a `Command` is a subtype of `Effect`. This doc covers
assembling the tree and sharing config across levels.

## Approaches

### Flat group: root + children

**When to use:** one level of subcommands under a root.

**Pattern:**

```typescript
import { Args, Command, Options } from "@effect/cli"
import { Console } from "effect"

const verbose = Options.boolean("verbose").pipe(Options.withAlias("v"))
const root = Command.make("tool", { verbose }).pipe(
  Command.withDescription("My accessibility tool")
)

const check = Command.make("check", { path: Args.text({ name: "path" }) }, ({ path }) =>
  Console.log(`checking ${path}`)
)
const init = Command.make("init", {}, () => Console.log("initializing"))

// withSubcommands takes a NON-EMPTY array; result is a single Command.
const command = root.pipe(Command.withSubcommands([check, init]))
```

`Command.run(command, ...)` then dispatches `tool check ...`, `tool init`, etc. The parsed
config of `command` gains a `subcommand: Option<...>` discriminating which child ran.

### Nested groups: a group that itself has children

**When to use:** two levels, e.g. `naval_fate ship new`, `naval_fate mine set`.

**Pattern:**

```typescript
import { Command } from "@effect/cli"

const shipGroup = Command.make("ship", { verbose: Options.boolean("verbose") })
const mineGroup = Command.make("mine")

const command = Command.make("naval_fate").pipe(
  Command.withSubcommands([
    shipGroup.pipe(Command.withSubcommands([newShip, moveShip, shootShip])),
    mineGroup.pipe(Command.withSubcommands([setMine, removeMine]))
  ])
)
```

`withSubcommands` composes: a child group is just a `Command` that already has its own
children attached before being listed in the parent.

### Child reading parent config (`Effect.gen`)

**When to use:** a child handler needs a global flag declared on the parent.

**Pattern:**

```typescript
import { Args, Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"

const root = Command.make("tool", { verbose: Options.boolean("verbose") })

const check = Command.make("check", { path: Args.text({ name: "path" }) }, ({ path }) =>
  Effect.gen(function*() {
    // Yielding the parent Command yields its parsed config.
    const { verbose } = yield* root
    yield* Console.log(`checking ${path}`)
    if (verbose) yield* Console.log("(verbose)")
  })
)

const command = root.pipe(Command.withSubcommands([check]))
```

### Child reading parent config (`Effect.flatMap`)

**When to use:** same goal, point-free style without a generator.

**Pattern:**

```typescript
import { Args, Command, Options } from "@effect/cli"
import { Console, Effect, Option } from "effect"

const root = Command.make("tool", {
  configs: Options.keyValueMap("c").pipe(Options.optional)
})

const child = Command.make("clone", { repo: Args.text({ name: "repo" }) }, (childCfg) =>
  Effect.flatMap(root, (parentCfg) => {
    const cfgs = Option.match(parentCfg.configs, {
      onNone: () => "",
      onSome: (m) => Array.fromIterable(m).map(([k, v]) => `${k}=${v}`).join(", ")
    })
    return Console.log(`clone ${childCfg.repo} with ${cfgs}`)
  })
)

const command = root.pipe(Command.withSubcommands([child]))
```

## Decision guide

| Situation | Approach | Why |
|---|---|---|
| One level of verbs | flat root + children | Simplest tree |
| Verbs that have their own verbs | nested `withSubcommands` | Groups compose recursively |
| Child needs a global flag | `yield* parent` in `Effect.gen` | Command is an Effect; reads parsed config |
| Same, point-free | `Effect.flatMap(parent, ...)` | Equivalent without generator |

## Rules

- `Command.withSubcommands` requires a **non-empty** tuple of commands.
- When a child reads its parent via `yield*`/`flatMap`, the child's `R` gains
  `Command.Context<ParentName>`. `Command.withSubcommands` **erases** that parent context from
  the resulting command's environment — so the assembled root needs no extra layer for it.
- The parsed config of the assembled command adds `subcommand: Option<...>`; the root's own
  handler still runs when no subcommand is given (e.g. just `tool`).
- Options/args attached to the **root** must be typed on the command line **before** the
  subcommand name: `tool --verbose check x`, not `tool check x --verbose`.

## Anti-patterns

| Don't do this | Why it breaks |
|---|---|
| `Command.withSubcommands([])` | Needs a non-empty array; empty is a type error |
| Closing over a parent's flag variable in a child handler | Closure captures the *declaration*, not the *parsed value*; use `yield* parent` |
| Placing root options after the subcommand | Parser binds options to the command they precede |
| Forgetting to `.pipe(Command.withSubcommands(...))` on a group | The group's children never get registered |

## See also

- [command.md](./command.md) — defining each command and its handler
- [running.md](./running.md) — running the assembled root command
- [help.md](./help.md) — subcommands appear under `COMMANDS` in `--help`
