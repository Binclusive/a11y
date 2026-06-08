#!/usr/bin/env node
/**
 * Runnable entry point for the published package.
 *
 * The package ships TypeScript source (no build step) and is launched as
 * `npx @binclusive/a11y <command>` by the plugin's `.mcp.json` / `hooks.json`.
 * Node can't execute `.ts` directly, so this thin JS wrapper registers the
 * `tsx` loader (resolved from THIS package's own node_modules, so it works no
 * matter what the caller's cwd is) and hands argv straight to `src/cli.ts`.
 *
 * eslint and its plugins stay ordinary dependencies — npm installs them — so
 * there is nothing to bundle and nothing fragile to keep in sync.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
// Absolute path to tsx's self-registering entry inside this package's deps.
const tsxEntry = pathToFileURL(require.resolve("tsx")).href;
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

const child = spawn(
  process.execPath,
  ["--import", tsxEntry, cli, ...process.argv.slice(2)],
  { stdio: "inherit" },
);

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
child.on("error", (err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
