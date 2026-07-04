/**
 * The thin CLI over {@link scopeChangedTsxFromEnv} that `entrypoint.sh` invokes,
 * so the CI Action resolves its changed-file scope through the SAME module the
 * engine imports — no second copy of the diff logic in shell. Reads the CI env
 * (`CHANGED_FILES` / `BASE_SHA` / `HEAD_SHA` / `GITHUB_WORKSPACE`) and prints the
 * resolved `.tsx` paths, one per line, to stdout.
 */
import { scopeChangedTsxFromEnv } from "./diff-scope";

for (const file of scopeChangedTsxFromEnv()) {
  process.stdout.write(`${file}\n`);
}
