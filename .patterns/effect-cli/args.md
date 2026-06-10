# Args (positional arguments)

`Args` declare the positional, un-prefixed inputs a command accepts — `<text>`, `<path>`,
`<url>...`. Each constructor returns `Args<A>`; the combinators mirror `Options` exactly
(`optional`, `withDefault`, `repeated`, `between`, `map`, `mapEffect`, `withSchema`). The
difference from `Options`: an `Args` constructor takes an optional **config object** with a
`name` (used in help / usage), not a leading name string. The parsed value lands in the handler
under the key you gave it in the command config object.

## Approaches

### Single typed positional

**When to use:** the command needs one required positional value.

**Pattern:**

```typescript
import { Args } from "@effect/cli"

const text = Args.text({ name: "text" })          // Args<string>   <text>
const count = Args.integer({ name: "count" })     // Args<number>   <count>
const ratio = Args.float({ name: "ratio" })       // Args<number>
const when = Args.date({ name: "since" })         // Args<Date>

// The config object is optional; the name defaults to the type ("text", "integer", ...).
const anon = Args.text() // <text>
```

### File / directory positional (with existence checks)

**When to use:** the positional is a filesystem path; optionally enforce existence.

**Pattern:**

```typescript
import { Args } from "@effect/cli"

const file = Args.file({ name: "input", exists: "yes" })   // Args<string>, must exist
const dir = Args.directory({ name: "out", exists: "no" })  // Args<string>, must NOT exist
const anyPath = Args.path({ name: "target" })              // file or directory

// Read the file's contents instead of just its path:
const text = Args.fileText()        // Args<readonly [path: string, content: string]>
const bytes = Args.fileContent()    // Args<readonly [path, Uint8Array]>
const parsed = Args.fileParse({ format: "json" }) // Args<unknown> (parsed json/yaml/ini/toml)
```

`exists` is `"yes" | "no" | "either"`.

### Choice positional

**When to use:** the positional must be one of a fixed labeled set.

**Pattern:**

```typescript
import { Args } from "@effect/cli"

const mode = Args.choice(
  [["fast", "fast" as const], ["safe", "safe" as const]],
  { name: "mode" }
) // Args<"fast" | "safe">
```

Unlike `Options.choice` (which takes a plain string array), `Args.choice` takes
`[label, value]` pairs.

### Repeated positional (`<url>...`)

**When to use:** the command accepts zero-or-more (or bounded) trailing positionals.

**Pattern:**

```typescript
import { Args } from "@effect/cli"

const urls = Args.text({ name: "url" }).pipe(Args.repeated)
//    ^? Args<Array<string>>   absent => []

// Bounded counts:
const oneToThree = Args.text({ name: "x" }).pipe(Args.between(1, 3)) // NonEmptyArray
const atLeastOne = Args.text({ name: "x" }).pipe(Args.atLeast(1))    // NonEmptyArray
const atMostTwo = Args.text({ name: "x" }).pipe(Args.atMost(2))      // Array
```

### Optional positional

**When to use:** a trailing positional that may be omitted; you want to branch on absence.

**Pattern:**

```typescript
import { Args } from "@effect/cli"
import { Option } from "effect"

const directory = Args.directory().pipe(Args.optional)
//    ^? Args<Option<string>>
```

### Positional with a default

**When to use:** omittable positional with a concrete fallback (no `Option`).

**Pattern:**

```typescript
import { Args } from "@effect/cli"

const count = Args.integer().pipe(Args.withDefault(1))
//    ^? Args<number>   absent => 1
```

### Validation / coercion

**When to use:** transform or reject the parsed positional.

**Pattern:**

```typescript
import { Args } from "@effect/cli"
import { Effect } from "effect"
import { HelpDoc } from "@effect/cli"

const upper = Args.text({ name: "name" }).pipe(Args.map((s) => s.toUpperCase()))

// Effectful — note Args.mapEffect fails with a HelpDoc (not ValidationError):
const checked = Args.text({ name: "path" }).pipe(
  Args.mapEffect((p) =>
    p.length > 0 ? Effect.succeed(p) : Effect.fail(HelpDoc.p("path cannot be empty"))
  )
)

const validated = Args.integer({ name: "port" }).pipe(
  Args.withSchema(Schema.Int.pipe(Schema.between(1, 65535)))
)
```

## Decision guide

| Need | Constructor / combinator | Result type |
|---|---|---|
| one required value | `Args.text/integer/float/date({ name })` | `A` |
| a filesystem path | `Args.file` / `Args.directory` / `Args.path` | `string` |
| read the file too | `Args.fileText` / `fileContent` / `fileParse` | tuple / parsed |
| one of a labeled set | `Args.choice([[label, value]], { name })` | union |
| zero-or-more trailing | `.pipe(Args.repeated)` | `Array<A>` |
| bounded count | `Args.between` / `atLeast` / `atMost` | `Array`/`NonEmptyArray` |
| omittable, branch on absence | `.pipe(Args.optional)` | `Option<A>` |
| omittable with fallback | `.pipe(Args.withDefault(x))` | `A` |
| custom reject/transform | `Args.map` / `mapEffect` / `withSchema` | mapped type |

## Rules

- `Args` constructors take an optional config object (`{ name, exists?, format? }`), NOT a
  leading name string — that is the key difference from `Options`.
- `Args.mapEffect` fails with a `HelpDoc`; `Options.mapEffect` fails with a `ValidationError`.
- Only the **last** positional should be `repeated`/`optional` — trailing variadic args are
  the parseable shape; an optional positional before a required one is ambiguous.
- Positionals are parsed **after** options and **before** subcommands.
- `Args.choice` pairs are `[label, value]`; `Options.choice` is a flat string array.

## Anti-patterns

| Don't do this | Why it breaks |
|---|---|
| `Args.text("name")` (string arg) | First arg is a **config object** `{ name: "..." }`, not a string |
| Two `repeated` positionals in one command | Parser can't decide where one list ends and the next begins |
| Required positional after an optional one | Ambiguous; make trailing ones optional/repeated instead |
| Expecting `Args.optional` to give `A` | It gives `Option<A>`; use `withDefault` for a plain value |

## See also

- [options.md](./options.md) — named flags; same combinator vocabulary
- [command.md](./command.md) — putting args into the command config object
- [help.md](./help.md) — `Args.withDescription` for help text
