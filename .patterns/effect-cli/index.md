# @effect/cli patterns

How to build a command-line application with `@effect/cli`: the Effect-TS CLI framework
where a `Command` is a value (subtype of `Effect`), inputs are declared with `Options` and
`Args` combinators, and `Command.run` turns the command tree into a runnable program that
consumes `process.argv`. These patterns make agents write correct CLIs without guessing
constructor names, combinator signatures, or the runtime wiring.

Scope: the `@effect/cli` package only — `Command`, `Options`, `Args`, `CliConfig`,
`Command.run` wiring. Built-in `Prompt` and `ConfigFile`/`withFallbackConfig` are covered
where they touch command definition. Excluded: `Prompt` as a standalone interactive-UI
library, shell completion internals, the low-level `CommandDescriptor`/`CliApp` APIs (you
almost always use the `Command` module instead).

## Index

| Doc | Concern | Read when |
|---|---|---|
| [command.md](./command.md) | Defining a command with `Command.make`, config object, handler | Writing any command or its effect handler |
| [options.md](./options.md) | Named flags: boolean, string, choice, valued, optional, defaults | Declaring `--json`, `--wcag a,b`, `--output x` style flags |
| [args.md](./args.md) | Positional arguments: text/integer/file, repeated, optional, defaults | Declaring `<path>` / `<url>...` positionals |
| [subcommands.md](./subcommands.md) | Command groups via `withSubcommands`, parent-config access | Building a root command with `check`/`init`/`gen`/... children |
| [help.md](./help.md) | Descriptions, help doc generation, built-in `--help`/`--version` | Adding descriptions or controlling help/version output |
| [running.md](./running.md) | `Command.run`, `NodeRuntime`, `process.argv`, layers, exit codes | Wiring the `bin` entrypoint and running the CLI |
| [recipes.md](./recipes.md) | Full multi-concern CLIs composed end-to-end | Assembling a complete tool from the concerns above |

## Shared conventions

- All examples are TypeScript / ESM. Import the modules from `@effect/cli`:
  `import { Args, Command, Options } from "@effect/cli"`.
- A Node entrypoint also needs `@effect/platform-node` (`NodeContext`, `NodeRuntime`).
- `effect` is the source of `Effect`, `Console`, `Option`, `Array`, `Config`, `Layer`.
- Peer dependencies: `effect`, `@effect/platform`, `@effect/printer`, `@effect/printer-ansi`.
- Combinators are dual: `Options.withDefault(opt, x)` and `opt.pipe(Options.withDefault(x))`
  are equivalent. Examples use `.pipe(...)` — the idiomatic form.
