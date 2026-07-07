# Conventional Commits

The contract a commit message follows so a machine can read *what kind of change*
it is and *what version bump* it implies. Automation like release-please derives
the next SemVer version entirely from this contract — so the automation is only
as correct as the messages are compliant. This doc is the spec surface: the
message grammar, and the mapping from commit type to bump.

Source: the [Conventional Commits v1.0.0 spec](https://www.conventionalcommits.org/en/v1.0.0/).

## The message grammar

```
<type>[optional scope][optional !]: <description>

[optional body]

[optional footer(s)]
```

- **type** — a noun categorising the change (`feat`, `fix`, `chore`, `docs`, …),
  followed by an optional scope, an optional `!`, then `: ` and a description.
- **scope** — an optional parenthesised noun describing the area of the codebase:
  `feat(parser): …`. It does not affect the bump.
- **description** — a short summary on the subject line.
- **body** — free-form paragraphs after a blank line, for detail.
- **footers** — `token: value` lines (git-trailer format) after a blank line;
  the reserved footer `BREAKING CHANGE:` is the one that carries release meaning.

## The bump mapping

This is the whole reason the format exists — each shape maps to a SemVer bump
(per the spec's *"How does this relate to SemVer?"* FAQ):

| Commit shape | SemVer bump | Example |
|---|---|---|
| `fix:` | **PATCH** | `fix: handle empty input` |
| `feat:` | **MINOR** | `feat: add dark mode` |
| Any type with `!` **or** a `BREAKING CHANGE:` footer | **MAJOR** | `feat!: drop node 18` / footer `BREAKING CHANGE: …` |
| Other types (`chore`, `docs`, `refactor`, `test`, `ci`, `build`, `perf`, `style`, …) | **no release** | `chore: bump dev dep` |

Key rules from the spec:

- **`fix` → PATCH, `feat` → MINOR** are the only two types the spec itself binds
  to a bump. Both correlate to SemVer PATCH and MINOR respectively.
- **A breaking change is orthogonal to type.** It is signalled *either* by a `!`
  immediately before the `:` (`feat!:`, `chore!:`) *or* by a `BREAKING CHANGE:`
  footer (uppercase, with a description). Either one forces a **MAJOR** bump
  **regardless of the type** — a breaking `chore` is still a major.
- **Other types carry no release meaning by default.** `chore`, `docs`,
  `refactor`, etc. are valid Conventional Commits but do not, on their own,
  produce a release. They still structure history and can appear in a changelog,
  but they do not move the version.

## Rules

- The **type prefix is mandatory and structured** — `type: description` at
  minimum. A message without a recognised type prefix carries no machine-readable
  bump intent and is invisible to version inference.
- **`!` and `BREAKING CHANGE:` are the same signal, two syntaxes** — use `!` on
  the subject line for brevity, or the footer when you need to describe the break.
  A footer's token is literally `BREAKING CHANGE` (or the synonym `BREAKING-CHANGE`).
- **Type ≠ bump for breaking changes.** Do not assume only `feat`/`fix` can
  release; any type + a breaking marker is a MAJOR.
- **Scope is descriptive, never load-bearing for the bump.** `feat(api):` and
  `feat:` bump identically.

## Anti-patterns

| Don't do this | Why it breaks |
|---|---|
| Free-text subject with no `type:` prefix | No machine-readable intent; version inference skips it entirely |
| `feat: …` for a breaking change without `!`/`BREAKING CHANGE:` | Inferred as MINOR — consumers get a silent breaking change on a non-major bump |
| Lowercase or reworded `breaking change:` footer | The reserved token is `BREAKING CHANGE`/`BREAKING-CHANGE`; a variant is not recognised |
| Expecting `chore:`/`docs:` to cut a release | Non-`feat`/`fix` types carry no bump by default; the version does not move |

## See also

- [release-please.md](./release-please.md) — the automation that reads this
  contract and computes the next version from the commit history
- [changesets.md](./changesets.md) — the alternative where the bump is declared
  per-PR in a file instead of inferred from the commit type
