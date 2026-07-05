#!/usr/bin/env node
/**
 * Runnable entry for the inline PR-comment reconciler (`src/pr-comment-cli.ts`),
 * invoked by `entrypoint.sh` after a scan. Mirrors `bin/diff-scope.mjs`: the
 * package ships TypeScript source (no build step), so this thin JS wrapper
 * registers the `tsx` loader (resolved from THIS package's own deps, cwd-proof)
 * and hands off to the CLI, forwarding the findings-report path argument.
 *
 * The CLI de-duplicates across pushes (issue #2131) — it updates a finding's
 * comment in place and removes fixed findings instead of re-POSTing every run.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const tsxEntry = pathToFileURL(require.resolve("tsx")).href;
const cli = fileURLToPath(new URL("./src/pr-comment-cli.ts", import.meta.url));

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
