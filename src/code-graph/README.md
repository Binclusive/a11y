# @b8e/code-graph

Agent-native TypeScript code-graph + smell tool. Point it at a folder; it parses
every `.ts`/`.tsx` (via `ts-morph`), measures each function (loc, complexity,
nesting depth, comment lines), groups them into modules and directories, flags
smells against the thresholds in `schema.ts`, and ranks refactor targets. Output
is deterministic JSON (sorted object keys, sorted arrays — same input, same
bytes) so an agent reads a graph instead of re-reading files.

The default run is **cheap** (no tsconfig, syntactic getters only — fast). Call
edges (`calls`/`calledBy`/`importedBy`/`callChainDepth` + their smells) are an
**opt-in** pass triggered by `--edges`, `--deep`, or `--blast`.

## Invocation

The canonical invocation is `pnpm code-graph <path> [flags]` run **from the repo root**, where `<path>` is relative to the repo root (e.g. `pnpm code-graph services/audit-agents --plan`). Absolute paths also work. The root `code-graph`
script runs the tool from source via `tsx` with cwd = repo root, so root-relative
paths resolve — no build step needed. The tables below write `code-graph X` for
brevity; read that as `pnpm code-graph X` from the repo root.

## Usage contract

When sent to refactor folder `X`, the first moves are Bash calls, not Reads:

| Goal | Call |
|---|---|
| Orient — health + worst offenders (first call) | `code-graph X` |
| Ranked refactor targets, re-rankable | `code-graph X --plan [--by rot\|impact\|complexity\|size]` |
| Indented file → function tree with inline smell markers | `code-graph X --tree` |
| One file's functions + line ranges | `code-graph X --file <f>` |
| Blast radius before changing a signature (intra-package) | `code-graph X --blast <id>` |
| **Cross-package** blast radius (before changing a shared export) | `code-graph X --blast <id> --deep` |
| Full graph (rarely — large) | `code-graph X --graph` |
| CI gate (fail on smells) | `code-graph X --ci [--fail-on high\|warn] [--max <n>]` |

`--blast` requires an unambiguous target — pass the `id` (`file:name`), not a
bare name. In default (`package`) scope, blast output is flagged incomplete for
cross-package callers; re-run with `--deep`.

## Flags

| Flag | Behavior |
|---|---|
| (none) | `Summary` JSON: health band, counts, worst file/function, top targets, parse failures |
| `--graph` | Full `Graph` JSON (the large dump, on demand) |
| `--plan [--by rot\|impact\|complexity\|size]` | Ranked `PlanRow[]` (human table, top 20). `--json` → full `PlanRow[]` |
| `--smells` | All smells grouped by kind (human). `--json` → `Smell[]` |
| `--tree` | Indented `file → function  L12-48  loc=36 cx=8 nest=3 [smell markers]`. Color when a TTY, plain when piped. `--json` falls back to the full graph |
| `--file <f>` | One module + its functions. Warns if `<f>` is in `parseFailures` |
| `--blast <id>` | Direct + transitive callers of `<id>`. Ambiguous bare name exits non-zero. `package` scope flags omitted cross-package callers |
| `--edges` | Opt-in edge pass at `package` scope: adds edge data + the `high-fan-in` / `deep-call-chain` smells |
| `--deep` | Edge pass over the whole monorepo; implies `--edges` at `deep` scope |
| `--ci [--fail-on high\|warn] [--max <n>]` | Gate: exit non-zero per policy. `--fail-on high` (default) fails on any high-severity smell; `--fail-on warn` fails on any smell; `--max <n>` fails if total smell count exceeds `n`. Cheap by default; add `--edges`/`--deep` to gate on edge smells too |
| `--thresholds <file>` | JSON file of partial threshold overrides, parsed through `ThresholdsSchema.partial()` and merged over the defaults. A typo'd key or wrong-typed value exits cleanly (exit code 2, one-line message) |
| `--pretty` | Pretty-print JSON output |
| `--json` | Force JSON output on a view command |

(No `--out` — redirect stdout.)

## Self-gate

`@b8e/code-graph` gates itself. `src/selfcheck.test.ts` runs the tool's cheap-pass
analysis on its own `src/` against `selfcheck.thresholds.json` and fails the build
if any non-test function trips a structural smell — so the tool meets the standard
it enforces. The gate runs at the **defaults** (`selfcheck.thresholds.json` is `{}`,
no relaxed threshold); test files are excluded because their fixtures are
intentionally gnarly. The failure message names the offending `kind`, `target`, and
`value` vs `threshold`, so a regression is obvious without re-running the CLI.

Read [`SPEC.md`](./SPEC.md) for the contract.
