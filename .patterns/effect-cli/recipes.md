# @effect/cli recipes

Full compositions of the concern files for common CLI shapes. Each recipe is adapted from a
runnable example in the `@effect/cli` repo (`minigit.ts`, `naval-fate.ts`) and names the
concern files it draws from. Copy a recipe whole — it is the complete shape, not a fragment.

## Multi-verb tool with a global flag

**Combines:** [command.md](./command.md) (full + name-only) + [options.md](./options.md)
(boolean, optional, withDefault) + [args.md](./args.md) (text, optional, repeated) +
[subcommands.md](./subcommands.md) (flat group) + [running.md](./running.md) (standard entry).

Adapted from `minigit.ts`: a root command with global options and two subcommands.

```typescript
import { Args, Command, Options } from "@effect/cli"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { Array, Console, Effect, Option } from "effect"

// root: tool [-c k=v]
const configs = Options.keyValueMap("c").pipe(Options.optional)
const root = Command.make("tool", { configs }, ({ configs }) =>
  Option.match(configs, {
    onNone: () => Console.log("Running 'tool'"),
    onSome: (m) =>
      Console.log(`configs: ${Array.fromIterable(m).map(([k, v]) => `${k}=${v}`).join(", ")}`)
  })
)

// tool add [-v|--verbose] <pathspec>...
const pathspec = Args.text({ name: "pathspec" }).pipe(Args.repeated)
const verbose = Options.boolean("verbose").pipe(Options.withAlias("v"))
const add = Command.make("add", { pathspec, verbose }, ({ pathspec, verbose }) => {
  const paths = Array.match(pathspec, {
    onEmpty: () => "",
    onNonEmpty: (p) => ` ${Array.join(p, " ")}`
  })
  return Console.log(`Running 'add${paths}' with '--verbose ${verbose}'`)
})

// tool clone [--depth n] <repository> [<directory>]
const repository = Args.text({ name: "repository" })
const directory = Args.directory().pipe(Args.optional)
const depth = Options.integer("depth").pipe(Options.optional)
const clone = Command.make("clone", { repository, directory, depth }, (cfg) => {
  const d = Option.map(cfg.depth, (n) => `--depth ${n}`)
  const optsAndArgs = Array.getSomes([d, Option.some(cfg.repository), cfg.directory])
  return Console.log(`Running 'clone' with: '${Array.join(optsAndArgs, ", ")}'`)
})

const command = root.pipe(Command.withSubcommands([add, clone]))

const cli = Command.run(command, { name: "Tool", version: "v1.0.0" })

cli(process.argv).pipe(Effect.provide(NodeContext.layer), NodeRuntime.runMain)
```

**Why this composition:** the global option (`configs`) lives on `root`, so it must be typed
before the subcommand on the command line (`tool -c k=v clone ...`). `repeated`/`optional`
positionals sit last in each child so parsing is unambiguous.

**Gotchas specific to this combination:**
- `Options.optional` gives `Option<...>` — handlers must `Option.match`/`Option.map`, not read
  the value directly.
- An empty `repeated` arg is `[]`, never `undefined`.

## Nested groups + child reads parent config + custom layers

**Combines:** [command.md](./command.md) (`Effect.gen` handler) + [options.md](./options.md)
(boolean, integer + withDefault) + [args.md](./args.md) (integer args) +
[subcommands.md](./subcommands.md) (nested + parent access) +
[help.md](./help.md) (`withDescription`, `CliConfig`) + [running.md](./running.md) (layers).

Adapted from `naval-fate.ts`: two-level subcommands, a child reading the parent's flag, and a
merged layer stack including a custom `CliConfig` and a service layer.

```typescript
import { CliConfig, Command, Options } from "@effect/cli"
import { Args } from "@effect/cli"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { Console, Effect, Layer } from "effect"

const xArg = Args.integer({ name: "x" }).pipe(Args.withDescription("The x coordinate"))
const yArg = Args.integer({ name: "y" }).pipe(Args.withDescription("The y coordinate"))
const speed = Options.integer("speed").pipe(
  Options.withDescription("Speed in knots"),
  Options.withDefault(10)
)

// Parent group carries a global --verbose.
const ship = Command.make("ship", { verbose: Options.boolean("verbose") }).pipe(
  Command.withDescription("Controls a ship")
)

// Child reads the parent's parsed config via `yield* ship`.
const newShip = Command.make("new", { name: Args.text({ name: "name" }) }, ({ name }) =>
  Effect.gen(function*() {
    const { verbose } = yield* ship
    yield* Console.log(`Created ship: '${name}'`)
    if (verbose) yield* Console.log("Verbose mode enabled")
  })
).pipe(Command.withDescription("Create a new ship"))

const moveShip = Command.make("move", { name: Args.text({ name: "name" }), x: xArg, y: yArg, speed },
  ({ name, speed, x, y }) =>
    Console.log(`Moving '${name}' to (${x}, ${y}) at ${speed} knots`)
).pipe(Command.withDescription("Move a ship"))

const command = Command.make("naval_fate").pipe(
  Command.withDescription("An implementation of the Naval Fate CLI application."),
  Command.withSubcommands([
    ship.pipe(Command.withSubcommands([newShip, moveShip]))
  ])
)

const MainLayer = Layer.mergeAll(
  CliConfig.layer({ showBuiltIns: false }),
  NodeContext.layer
)

const cli = Command.run(command, { name: "Naval Fate", version: "1.0.0" })

Effect.suspend(() => cli(process.argv)).pipe(
  Effect.provide(MainLayer),
  Effect.tapErrorCause(Effect.logError),
  NodeRuntime.runMain
)
```

**Why this composition:** the child handler must be an `Effect.gen` (not a plain return) so it
can `yield* ship` to obtain the parent's parsed `verbose`. `Command.withSubcommands` then
erases `Command.Context<"ship">` from the assembled root, so no extra layer is needed for it.

**Gotchas specific to this combination:**
- `yield* ship` yields the parent's **parsed config**, available only because the child is
  nested under it via `withSubcommands` — it fails for an unrelated command.
- Merge `NodeContext.layer` into `MainLayer`; the run `Effect` always needs
  `FileSystem | Path | Terminal`.
- `CliConfig.layer({ showBuiltIns: false })` hides `--completions`/`--wizard` from help output
  but they still function.
