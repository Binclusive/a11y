# Uploading SARIF to code scanning

A static-analysis action typically produces a SARIF file (the standard interchange format
for analysis results) and then hands it to GitHub so the findings surface in the repo's
**code scanning** UI, as PR annotations and Security-tab alerts. The upload is done by the
`github/codeql-action/upload-sarif` action. The two things authors get wrong are the
**required permissions** and the **prerequisite checkout** — without either, the upload
step fails.

## Approaches

### Upload a single SARIF file

**When to use:** one analysis run produced one SARIF file.

**Pattern:**

```yaml
name: Code scan
on:
  push:
  pull_request:

jobs:
  scan:
    runs-on: ubuntu-latest
    permissions:
      security-events: write   # required — write the results
      actions: read            # required for private repos
      contents: read           # required for private repos
    steps:
      - name: Check out repository
        uses: actions/checkout@v6

      - name: Run the analyzer
        uses: some-owner/analyzer@v1   # produces results.sarif

      - name: Upload SARIF
        uses: github/codeql-action/upload-sarif@v4
        with:
          sarif_file: results.sarif    # file or directory, relative to repo root
```

**Gotchas:**
- `security-events: write` is **mandatory** — the default `GITHUB_TOKEN` does not carry it
  unless you request it. `actions: read` and `contents: read` are additionally required for
  **private** repositories.
- `sarif_file` is relative to the **repository root** and may be a single file **or a
  directory** of `.sarif` files.

### Upload multiple runs (distinguish with `category`)

**When to use:** several analyses run against the same commit — different tools, languages,
or configurations — and each must keep its own set of alerts.

**Pattern:**

```yaml
      - name: Upload tool-A SARIF
        uses: github/codeql-action/upload-sarif@v4
        with:
          sarif_file: tool-a.sarif
          category: tool-a

      - name: Upload tool-B SARIF
        uses: github/codeql-action/upload-sarif@v4
        with:
          sarif_file: tool-b.sarif
          category: tool-b
```

**Gotchas:**
- Without a distinct `category` per run, a later upload for the same commit **replaces** the
  earlier run's results instead of adding to them.

### Upload via the REST API

**When to use:** the SARIF is produced outside a workflow, or you need programmatic control.

**Pattern:**

```
POST /repos/{owner}/{repo}/code-scanning/sarifs
```

with a gzipped, base64-encoded SARIF payload and a commit SHA + ref. The same permission
model applies to the token used.

**Gotchas:**
- The API expects the SARIF gzipped then base64-encoded, not the raw file.

## Decision guide

| Situation | Approach |
|---|---|
| One tool, one result file, inside a workflow | single `upload-sarif` step |
| Multiple tools/configs on the same commit | one `upload-sarif` step each, distinct `category` |
| SARIF generated outside a workflow | `POST .../code-scanning/sarifs` |

## Rules

- The job must grant `security-events: write`; private repos additionally need
  `actions: read` and `contents: read`.
- The repository must be **checked out** (`actions/checkout`) before uploading — the upload
  correlates results to the checked-out commit.
- `sarif_file` is relative to the repository root and accepts a file or a directory.
- Each independent run against one commit needs a unique `category`.

## Anti-patterns

| Don't do this | Why it breaks |
|---|---|
| Omit the `permissions:` block | The default token lacks `security-events: write`; the upload is rejected. |
| Skip `actions/checkout` before the upload | The action cannot resolve the commit/ref to attach results to. |
| Upload two runs on one commit without `category` | The second upload overwrites the first — you lose one tool's alerts. |
| Give an absolute path to `sarif_file` | The input is resolved relative to the repository root, not the filesystem root. |

## See also

- [docker-actions.md](./docker-actions.md) — a container action is a common producer of the SARIF this step uploads.
- [action-metadata.md](./action-metadata.md) — declaring the analyzer action that emits the SARIF.
