# Defining a command

A `Command` ties three things together: a **name** (the word typed on the command line), a
**config object** declaring the `Options` and `Args` it accepts, and a **handler** — the
`Effect` that runs when the command is invoked. The handler receives the parsed config as a
plain object whose keys match the config object. A `Command` is itself a subtype of `Effect`,
which is what lets subcommands read a parent's parsed config. This doc covers how to construct
a command and shape its handler; flag/positional declaration lives in
[options.md](./options.md) and [args.md](./args.md).

## Approaches

### Full command: name + config + handler

**When to use:** the normal case — a command that takes inputs and does work.

**Pattern:**

```typescript
import { Args, Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"

const text = Args.text({ name: "text" })
const bold = Options.boolean("bold").pipe(Options.withAlias("b"))

// Keys of the config object ({ text, bold }) become keys of the handler argument.
const echo = Command.make("echo", { text, bold }, ({ bold, text }) =>
  Console.log(bold ? `\x1b[1m${text}\x1b[0m` : text)
)
```

The handler's parameter type is inferred from the config: `bold` is `boolean`, `text` is
`string`. The handler must return an `Effect<void, E, R>`.

**Gotchas:**
- The handler argument is a single destructurable object, not positional params.
- Config object **values** must be `Options`/`Args` (or nested arrays/objects of them). The
  keys are arbitrary identifiers — they only name the fields the handler sees.

### Name + config, handler attached later

**When to use:** a parent command that mostly groups subcommands, or when you want to build
the command shape first and attach behavior with `Command.withHandler`.

**Pattern:**

```typescript
import { Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"

// Two-arg form: no handler yet. Default handler does nothing.
const git = Command.make("git", {
  verbose: Options.boolean("verbose").pipe(Options.withAlias("v"))
}).pipe(Command.withDescription("the stupid content tracker"))

// Attach (or replace) the handler afterwards.
const withBehavior = git.pipe(
  Command.withHandler(({ verbose }) =>
    Console.log(verbose ? "verbose git" : "git")
  )
)
```

### Name only

**When to use:** a pure grouping command that has no own options and exists only to host
subcommands (e.g. a `ship` group under `naval_fate`).

**Pattern:**

```typescript
import { Command } from "@effect/cli"

const mine = Command.make("mine").pipe(
  Command.withDescription("Controls mines in Naval Fate")
)
// Attach children with Command.withSubcommands — see subcommands.md.
```

### Effect handler with `Effect.gen`

**When to use:** the handler needs to sequence multiple effects, read services from context,
or read a parent command's config.

**Pattern:**

```typescript
import { Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"

const ship = Command.make("ship", { verbose: Options.boolean("verbose") })

const newShip = Command.make("new", { name: Args.text({ name: "name" }) }, ({ name }) =>
  Effect.gen(function*() {
    // `yield* ship` yields the PARENT command's parsed config (Command is an Effect).
    const { verbose } = yield* ship
    yield* createShip(name)
    yield* Console.log(`Created ship: '${name}'`)
    if (verbose) yield* Console.log("Verbose mode enabled")
  })
)
```

## Decision guide

| Situation | Approach | Why |
|---|---|---|
| Command does work with its inputs | name + config + handler | Inline handler is the common shape |
| Pure subcommand group | name only / name + config | No behavior of its own; hosts children |
| Need services or parent config | `Effect.gen` handler | Can `yield*` services and parent commands |
| Build shape, decide behavior later | `withHandler` | Separates structure from effect |

## Rules

- The handler return type must be `Effect<void, E, R>`. The success channel is `void`.
- Config object keys are free-form; their **values** must be `Options`, `Args`, or nested
  `ReadonlyArray`/record of those.
- A `Command<Name, R, E, A>` carries `R` (handler requirements), `E` (handler errors) and `A`
  (the parsed config type). `R` must be eliminated before `Command.run` executes (see
  [running.md](./running.md)).
- `Command.make` is overloaded: 1 arg (name), 2 args (name + config), or 3 args
  (name + config + handler). Picking the 2-arg form gives a no-op default handler.

## Anti-patterns

| Don't do this | Why it breaks |
|---|---|
| Handler returns a plain string / value | Handler must return an `Effect`; a bare value won't run |
| `Command.make("name", () => ...)` (handler as 2nd arg) | 2nd arg is the **config object**; the handler is the 3rd arg |
| Reading parent config by closing over a variable | Use `yield* parentCommand` — closures don't get the parsed values |
| Putting raw strings/numbers in the config object | Config values must be `Options`/`Args`, not literals |

## See also

- [options.md](./options.md) — declaring the named flags in the config object
- [args.md](./args.md) — declaring the positional arguments in the config object
- [subcommands.md](./subcommands.md) — grouping commands and reading parent config
- [running.md](./running.md) — turning a command into a runnable program
