#!/usr/bin/env node
/**
 * Runnable entry for the changed-file diff-scoper (`src/diff-scope-cli.ts`),
 * called by `entrypoint.sh` so the CI Action shares the engine's ONE scoping
 * module instead of an inline `git diff | grep`. Mirrors `bin/a11y.mjs`: the
 * package ships TypeScript source (no build step), so this thin JS wrapper
 * registers the `tsx` loader (resolved from THIS package's own deps, cwd-proof)
 * and hands off to the CLI. Prints changed `.tsx` paths, one per line.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const tsxEntry = pathToFileURL(require.resolve("tsx")).href;
const cli = fileURLToPath(new URL("../src/diff-scope-cli.ts", import.meta.url));

const child = spawn(process.execPath, ["--import", tsxEntry, cli, ...process.argv.slice(2)], {
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
child.on("error", (err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
