# Running the CLI

`Command.run` turns a `Command` into a function `(args: ReadonlyArray<string>) =>
Effect<void, E | ValidationError, R | CliApp.Environment>`. You call that with `process.argv`,
provide the platform layers (`NodeContext.layer` gives `FileSystem`, `Path`, `Terminal`), and
hand the resulting `Effect` to a runtime (`NodeRuntime.runMain`) that executes it and sets the
process exit code. This doc covers the entrypoint wiring; defining the command tree is in
[command.md](./command.md) and [subcommands.md](./subcommands.md).

## Approaches

### Standard Node entrypoint

**When to use:** the default — a `bin` script run under Node via `tsx` or compiled JS.

**Pattern:**

```typescript
#!/usr/bin/env node
import { Command } from "@effect/cli"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { Console, Effect } from "effect"

const command = Command.make("hello-world", {}, () => Console.log("Hello World"))

// Command.run takes the root command + { name, version }. It returns a function of argv.
const cli = Command.run(command, {
  name: "Hello World CLI",
  version: "v1.0.0"
})

// process.argv is passed whole — Command.run strips the leading `node script.js`.
cli(process.argv).pipe(
  Effect.provide(NodeContext.layer), // FileSystem | Path | Terminal
  NodeRuntime.runMain                // runs it, wires SIGINT, sets exit code
)
```

### Entrypoint with extra layers (services / CliConfig)

**When to use:** the handlers depend on services, or you want a custom `CliConfig`.

**Pattern:**

```typescript
import { CliConfig, Command } from "@effect/cli"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { Effect, Layer } from "effect"

const cli = Command.run(command, { name: "Naval Fate", version: "1.0.0" })

const MainLayer = Layer.mergeAll(
  CliConfig.layer({ showBuiltIns: false }), // custom CLI config
  MyServiceLive,                            // your own service layer(s)
  NodeContext.layer                         // platform services — always include
)

// Effect.suspend defers reading process.argv until run time.
Effect.suspend(() => cli(process.argv)).pipe(
  Effect.provide(MainLayer),
  Effect.tapErrorCause(Effect.logError), // optional: log failures
  NodeRuntime.runMain
)
```

### Entrypoint with an env-var ConfigProvider

**When to use:** options use `Options.withFallbackConfig(Config.x("VAR"))` and you want them to
read from environment variables (optionally namespaced).

**Pattern:**

```typescript
import { Command } from "@effect/cli"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { ConfigProvider, Effect } from "effect"

const cli = Command.run(command, { name: "minigit", version: "v1.0.0" })

Effect.suspend(() => cli(process.argv)).pipe(
  // GIT_VERBOSE, GIT_DEPTH, ... feed the Config fallbacks.
  Effect.withConfigProvider(ConfigProvider.nested(ConfigProvider.fromEnv(), "GIT")),
  Effect.provide(NodeContext.layer),
  NodeRuntime.runMain
)
```

### Running a command in a test (no process)

**When to use:** unit-testing a command by feeding an explicit argv array.

**Pattern:**

```typescript
import { Command } from "@effect/cli"
import { NodeContext } from "@effect/platform-node"
import { Effect } from "effect"

const run = command.pipe(Command.run({ name: "git", version: "1.0.0" }))

// `yield*` is only legal inside a generator — drive the run from an Effect.gen
// test body. Pass a synthetic argv; the first two entries are treated as node + script.
const test = Effect.gen(function*() {
  yield* run(["node", "git.js", "add", "file"]).pipe(Effect.provide(NodeContext.layer))
})
```

## Decision guide

| Situation | Approach |
|---|---|
| Plain CLI, no services | standard Node entrypoint |
| Handlers need services / custom CliConfig | merge layers into `MainLayer` |
| Options fall back to env vars | add an env `ConfigProvider` via `Effect.withConfigProvider` |
| Testing without a real process | call the run function with an explicit argv array |

## Rules

- `Command.run(command, { name, version })` — `name` and `version` are **required**;
  `executable`, `summary`, `footer` are optional.
- Pass the **whole** `process.argv`. `Command.run` discards the first two entries
  (`node` + script path) for you; do not slice it yourself.
- The run `Effect` requires `CliApp.Environment` = `FileSystem | Path | Terminal`. On Node,
  `NodeContext.layer` supplies all three — always provide it (or another platform's context).
- The error channel includes `ValidationError`; `NodeRuntime.runMain` reports it and exits
  non-zero. A successful run exits `0`. Validation/parse failures and unknown args exit non-zero.
- `NodeRuntime.runMain` (not `Effect.runPromise`) is the entrypoint runner: it manages the
  fiber, interrupts on SIGINT, and sets `process.exitCode`.
- Use `Effect.suspend(() => cli(process.argv))` when you also call `Effect.withConfigProvider`
  or want argv read lazily; the direct `cli(process.argv).pipe(...)` form is fine otherwise.

## Anti-patterns

| Don't do this | Why it breaks |
|---|---|
| `cli(process.argv.slice(2))` | `Command.run` already strips `node` + script; double-slicing drops real args |
| Running with `Effect.runPromise` in the bin | Skips SIGINT handling and proper exit-code wiring; use `NodeRuntime.runMain` |
| Omitting `NodeContext.layer` | The run `Effect` needs `FileSystem | Path | Terminal`; it won't type-check / run |
| Leaving handler `R` unprovided | All service requirements must be provided before `runMain` |

## See also

- [command.md](./command.md) — building the command the runtime executes
- [subcommands.md](./subcommands.md) — assembling the root command tree
- [help.md](./help.md) — `CliConfig` tuning and built-in options injected at run time
