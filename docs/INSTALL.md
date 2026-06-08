# Installing the a11y plugin (Binclusive customers)

This plugin is distributed **privately** to Binclusive customers — it is not on
public npm. Setup is a one-time auth step, then two commands in your coding agent.
Everything runs on your machine; your code never leaves the laptop.

## 1. One-time: authenticate to the private registry

You need a GitHub account with read access to the `@binclusive` packages — ask your
Binclusive contact to grant it.

Create a GitHub Personal Access Token (classic) with the **`read:packages`** scope,
then add it to your npm config at `~/.npmrc`:

```ini
@binclusive:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=YOUR_GITHUB_TOKEN
```

Verify it resolves:

```bash
npm view @binclusive/a11y version   # prints a version, not 401/404
```

## 2. Install the plugin (Claude Code)

```text
/plugin marketplace add Binclusive/a11y-checker-plugin
/plugin install a11y-checker@binclusive
```

One install registers, together:

- the local **MCP server** — `check_a11y`, `get_a11y_rules`, `learn_a11y_rule`;
- the **auto-whisper hook** — flags a11y the instant the agent edits a file;
- the **`grind` skill** — ROBOT MODE.

## 3. Run ROBOT MODE

In Claude Code, just say:

```text
work through the a11y findings, highest-impact first
```

The agent loops: scan → rank by real-audit frequency → fix the mechanical
violations → propose the judgment ones (never placeholder text) → re-scan to
verify each fix cleared → repeat. It ends with a report of what it fixed, what
needs a human, and what it couldn't see.

## Other agents (Cursor, Copilot, Codex, Windsurf, Cline)

The MCP server is vendor-neutral. To use it outside Claude Code:

1. Add the server to your tool's MCP config (the same stdio command the plugin uses):

   ```json
   { "command": "npx", "args": ["-y", "@binclusive/a11y", "mcp"] }
   ```

2. In your project, run:

   ```bash
   npx @binclusive/a11y init
   ```

   This generates an `AGENTS.md` containing the ROBOT MODE loop **and** your repo's
   corpus rules. Cursor, Copilot, Codex, Windsurf, and Cline all read `AGENTS.md`,
   so your agent then runs the same grind loop — no file to copy by hand. (Claude
   Code reads `CLAUDE.md`, which `init` writes too.)

Re-run `init`/`learn` any time; they refresh the rules block and leave the rest of
the file untouched.
