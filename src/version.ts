import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/**
 * The single source of truth for the package version reported by the CLI
 * (`--version`) and the MCP handshake. Read from package.json at load time so
 * there is no literal to drift from what npm publishes.
 *
 * Safe on BOTH shipped paths because the package ships raw source with no
 * bundler to sever the relative link: the npm bin (`bin/a11y.mjs` → tsx →
 * `src/cli.ts`) and the Docker action (`COPY . .` → tsx → `src/cli.ts`) both
 * place package.json exactly one directory up from this module.
 */
const packageJsonPath = fileURLToPath(new URL("../package.json", import.meta.url));

export const VERSION: string = z
  .object({ version: z.string() })
  .parse(JSON.parse(readFileSync(packageJsonPath, "utf8"))).version;
