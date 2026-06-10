# Options (named flags)

`Options` declare the named, `--`-prefixed flags a command accepts: boolean switches
(`--json`), valued flags (`--output report.html`), choices (`--format json`), and repeated /
key-value flags. Each constructor returns `Options<A>`; combinators piped onto it change the
parsed type `A` (e.g. `Options.optional` turns `Options<A>` into `Options<Option<A>>`). The
parsed value lands in the handler under the key you gave it in the command config object.
This doc covers declaring flags and shaping their values; positionals are in
[args.md](./args.md).

## Approaches

### Boolean flag (`--json`)

**When to use:** an on/off switch. Present → `true`, absent → `false`.

**Pattern:**

```typescript
import { Options } from "@effect/cli"

const json = Options.boolean("json") // Options<boolean>; --json / --no-json

// With a short alias: -b
const bold = Options.boolean("bold").pipe(Options.withAlias("b"))

// Customize negation / default-present behavior:
const color = Options.boolean("color", {
  ifPresent: true,
  negationNames: ["no-color"],
  aliases: ["c"]
})
```

A boolean option auto-generates a negation (default `--no-<name>`). It never requires a value.

### String / numeric valued flag (`--output x`)

**When to use:** a flag that takes one value.

**Pattern:**

```typescript
import { Options } from "@effect/cli"

const output = Options.text("output")     // Options<string>   --output report.html
const depth = Options.integer("depth")    // Options<number>   --depth 3
const ratio = Options.float("ratio")      // Options<number>   --ratio 0.5
const since = Options.date("since")        // Options<Date>     --since 2024-01-01
const token = Options.redacted("token")    // Options<Redacted> value hidden in logs/help
```

### Choice flag (`--format json`)

**When to use:** the value must be one of a fixed set. The parsed type narrows to the union.

**Pattern:**

```typescript
import { Options } from "@effect/cli"

const format = Options.choice("format", ["json", "html", "sarif"])
//    ^? Options<"json" | "html" | "sarif">

// Map each choice to a richer value with choiceWithValue:
import * as Data from "effect/Data"
const Dog = Data.tagged<{ readonly _tag: "Dog" }>("Dog")
const Cat = Data.tagged<{ readonly _tag: "Cat" }>("Cat")
const animal = Options.choiceWithValue("animal", [["dog", Dog()], ["cat", Cat()]])
```

### Comma / repeated value flag (`--wcag a,b` style)

**When to use:** the flag accepts multiple values. Two shapes:

**Pattern A — repeated flag (`--wcag a --wcag b`):**

```typescript
import { Options } from "@effect/cli"

const wcag = Options.text("wcag").pipe(Options.repeated)
//    ^? Options<Array<string>>   absent => []
```

**Pattern B — single flag, split a comma string yourself (`--wcag a,b`):**

```typescript
import { Options } from "@effect/cli"

// Parse the raw string into an array via Options.map.
const wcag = Options.text("wcag").pipe(
  Options.map((s) => s.split(",").map((x) => x.trim()))
)
//    ^? Options<Array<string>>
```

`Options.repeated` is the framework-native multi-value form; the `map`-split form matches a
`--wcag a,b` UX. Use `between`/`atLeast`/`atMost` to bound a repeated count.

### Optional flag

**When to use:** the flag may be omitted and you want to handle absence explicitly.

**Pattern:**

```typescript
import { Command, Options } from "@effect/cli"
import { Array, Console, Option } from "effect"

const config = Options.keyValueMap("c").pipe(Options.optional)
//    ^? Options<Option<HashMap<string, string>>>

// In the handler, `config` is the PARSED value (Option<HashMap>); branch on presence:
const cmd = Command.make("run", { config }, ({ config }) =>
  Option.match(config, {
    onNone: () => Console.log("no config"),
    onSome: (map) => Console.log(`config: ${Array.fromIterable(map).length}`)
  })
)
```

### Flag with a default

**When to use:** the flag may be omitted but you want a concrete fallback (no `Option`).

**Pattern:**

```typescript
import { Options } from "@effect/cli"

const speed = Options.integer("speed").pipe(Options.withDefault(10))
//    ^? Options<number>   absent => 10  (NOT Option<number>)
```

### Key-value map flag (`-c k=v`)

**When to use:** repeated `key=value` pairs collected into a map.

**Pattern:**

```typescript
import { Options } from "@effect/cli"

const configs = Options.keyValueMap("c") // Options<HashMap<string,string>>
// -c key1=value1 -c key2=value2   OR   -c key1=value key2=value2
```

### Validation / coercion

**When to use:** transform or reject the parsed value with a custom rule.

**Pattern:**

```typescript
import { Options } from "@effect/cli"
import { Effect, Option, Schema } from "effect"
import { HelpDoc, ValidationError } from "@effect/cli"

// Pure transform:
const upper = Options.text("name").pipe(Options.map((s) => s.toUpperCase()))

// Reject with a message (filterMap keeps Some, fails on None):
const positive = Options.integer("n").pipe(
  Options.filterMap(
    (n) => (n > 0 ? Option.some(n) : Option.none()),
    "must be greater than 0"
  )
)

// Effectful validation/coercion (can read FileSystem | Path | Terminal):
const checked = Options.text("path").pipe(
  Options.mapEffect((p) =>
    p.endsWith(".html")
      ? Effect.succeed(p)
      : Effect.fail(ValidationError.invalidValue(HelpDoc.p("must be .html")))
  )
)

// Validate via a Schema:
const port = Options.integer("port").pipe(Options.withSchema(Schema.Int.pipe(Schema.between(1, 65535))))
```

## Decision guide

| Need | Constructor / combinator | Result type |
|---|---|---|
| on/off switch | `Options.boolean(name)` | `boolean` |
| one string value | `Options.text(name)` | `string` |
| one integer / float | `Options.integer` / `Options.float` | `number` |
| one of a fixed set | `Options.choice(name, [...])` | union of literals |
| omittable, branch on absence | `.pipe(Options.optional)` | `Option<A>` |
| omittable with fallback | `.pipe(Options.withDefault(x))` | `A` (no Option) |
| many of the same flag | `.pipe(Options.repeated)` | `Array<A>` |
| comma string → array | `.pipe(Options.map(s => s.split(",")))` | `Array<...>` |
| key=value pairs | `Options.keyValueMap(name)` | `HashMap<string,string>` |
| custom reject/transform | `Options.filterMap` / `mapEffect` / `withSchema` | mapped type |
| env-var fallback | `.pipe(Options.withFallbackConfig(Config.x("VAR")))` | `A` |

## Rules

- Combinator order matters for the type: `optional` after `withDefault` is redundant; pick one.
- `withDefault` yields a plain `A`; `optional` yields `Option<A>`. They are mutually exclusive
  ways to make a flag non-required.
- `withAlias` adds a short form (`-b`); the long form (`--bold`) always exists from the name.
- A boolean option's negation flag is auto-generated; override names via `negationNames`.
- Options are parsed **before** positional args and **before** any subcommand on the line.

## Anti-patterns

| Don't do this | Why it breaks |
|---|---|
| `Options.boolean("bold").pipe(Options.withDefault(false))` | Boolean already defaults to `false`; redundant |
| Treating `Options.optional` result as `A` | It is `Option<A>` — must `Option.match`/`getOrElse` |
| `Options.text("wcag")` then `.split(",")` in the handler | Do the split in the option via `map` so the handler sees `Array` |
| Passing the flag value before the command's positional args | Parser wants options before args; place flags first |

## See also

- [args.md](./args.md) — positional arguments share `optional`/`withDefault`/`repeated`
- [command.md](./command.md) — putting options into the command config object
- [help.md](./help.md) — `Options.withDescription` for help text
