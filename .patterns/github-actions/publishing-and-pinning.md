# Publishing and pinning an action

Once an action's `action.yml` exists, releasing it is a matter of **git tags** — an action
is consumed at a `@{ref}`, and the ref you move (or don't) is the whole versioning story.
This doc covers the two sides: the **maintainer** choosing a tagging strategy, and the
**consumer** choosing how to pin. The tension between them — convenience vs. immutability —
is the decision an author gets wrong.

## Maintainer: tagging a release

**When to use:** every time you cut a version of an action for others to consume.

**Pattern:**

Tag releases with **semantic version** tags and keep moving major/minor aliases:

```
vMAJOR.MINOR.PATCH   # the immutable release tag, e.g. the tag for a specific commit
vMAJOR               # a moving alias re-pointed to the latest release in that major line
vMAJOR.MINOR         # a moving alias re-pointed to the latest patch in that minor line
```

So a maintainer publishing a new patch:
1. Tags the exact commit with a full three-part tag (`vMAJOR.MINOR.PATCH`).
2. Force-moves the `v1` major alias (and the matching minor alias) to that same commit.

This lets a consumer write `uses: some-owner/action@v1` and automatically receive every
backward-compatible fix, while a consumer who wants tighter control pins a narrower alias.

**Gotchas:**
- The major alias is a **moving** tag — you re-point it on each compatible release. That is
  the feature (auto-updates) and the risk (the code behind `@v1` changes over time).
- When a tag and a branch share a name, the **tag wins** — avoid naming a branch `v1`.

## Consumer: pinning a reference

A consumer's `@{ref}` may be a branch, a tag, or a commit SHA. Choose by the trade-off:

### Pin to a major version alias

**When to use:** you trust the maintainer's semver and want automatic compatible updates.

```yaml
- uses: some-owner/action@v1
```

**Gotchas:**
- The code behind `@v1` can change under you — a moved alias is not immutable.

### Pin to a full commit SHA

**When to use:** you need reproducible, tamper-evident builds — third-party actions in a
security-sensitive pipeline.

```yaml
- uses: some-owner/action@e2f20e6318b6d3b1f7f6a3c2f6d0a...  # full 40-char SHA
```

**Gotchas:**
- You get no automatic updates — you must bump the SHA yourself to take fixes.
- A SHA is the only form a maintainer cannot silently move; a tag can be re-pointed.

## Publishing to GitHub Marketplace

**When to use:** you want the action discoverable and listed publicly.

Requirements enforced at publish time:
- The repository must be **public**.
- It must contain a **single** metadata file (`action.yml` or `action.yaml`) **at the root**.
  Metadata files in sub-folders are allowed but are **not** auto-listed in the Marketplace.
- The `name` in the metadata must be **unique** — it cannot match an existing Marketplace
  action, an existing user/org (unless that owner publishes it), or a Marketplace category.

Publishing is a per-release action: from the metadata file's page, draft a release and check
**"Publish this Action to the GitHub Marketplace"**, then pick a primary category. `branding`
(icon + color) drives the listing's appearance.

**Gotchas:**
- One repository lists **one** action in the Marketplace — the root metadata file. Shipping
  several actions from one repo (subdirectories) means the extra ones are usable via
  `owner/repo/path@ref` but not separately listed.
- Deleting the repository deletes the listing and frees the unique `name`.

## Decision guide

| Situation | Choose |
|---|---|
| Maintainer cutting a release | full `vMAJOR.MINOR.PATCH` tag + move `vMAJOR` alias |
| Consumer wanting auto-updates within a major line | `@vMAJOR` |
| Consumer needing reproducible / supply-chain-safe builds | `@<full-sha>` |
| Making the action publicly discoverable | root metadata + public repo + unique `name` + publish a release |

## Rules

- An action is versioned entirely by **git refs**; there is no separate version field in
  `action.yml` that consumers pin to.
- A commit SHA is immutable; a tag or branch can be moved. Pin the SHA when that matters.
- Marketplace listing requires a **single root** metadata file with a **unique** `name` in a
  **public** repo.
- A tag takes precedence over a branch of the same name.

## Anti-patterns

| Don't do this | Why it breaks |
|---|---|
| Pin a third-party action to `@main` in a sensitive pipeline | `main` moves with every push — arbitrary new code runs with your token and no review. |
| Never move the major alias after cutting releases | Consumers on `@v1` are frozen on the first release and silently miss every fix. |
| Put the Marketplace action's metadata in a subdirectory | Sub-folder metadata is not auto-listed; the Marketplace lists only a **root** `action.yml`. |
| Reuse a common word as the action `name` | A `name` colliding with an existing action, user, org, or category is rejected at publish. |

## See also

- [uses-resolution.md](./uses-resolution.md) — the consuming side of `@ref` and where the root metadata must live.
- [action-metadata.md](./action-metadata.md) — the `name`/`branding` fields the Marketplace reads.
