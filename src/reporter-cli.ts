/**
 * The thin CLI over the reporter-adapter seam (issue #2235) that `entrypoint.sh`
 * invokes (through the root `report.mjs` tsx wrapper) after a scan. It selects the
 * platform adapter by explicit key (`A11Y_PLATFORM`, defaulting to `github` so the
 * shipped Action is behavior-preserving), resolves the platform's post-context
 * from env, parses the engine's findings JSON, and dispatches to the reporter.
 *
 * Best-effort by design: any missing context, unknown platform, failed read, or
 * failed API call is logged to stderr and skipped — never thrown — so the calling
 * entrypoint always exits 0 (the gate is advisory). When the resolver finds no
 * PR/MR post-context, the reporter no-ops and the artifacts still emit.
 *
 * Args: <report-path>. Env: A11Y_PLATFORM (optional; default `github`), plus each
 * adapter's own env (GitHub: GITHUB_REPOSITORY / PR_NUMBER / HEAD_SHA / GITHUB_TOKEN
 * / GITHUB_API_URL / BINCLUSIVE_APP_*).
 */
import { readFileSync } from "node:fs";
import { dispatch, type Finding, parseFindings, resolvePlatformKey } from "./reporter/contract";
import { defaultRegistry } from "./reporter/registry";

const log = (msg: string): void => console.error(`reporter: ${msg}`);

const reportPath = process.argv[2];
if (!reportPath) {
  log("no report path argument; skipping");
  process.exit(0);
}

const key = resolvePlatformKey(process.env);
const adapter = defaultRegistry().select(key);
if (!adapter) {
  log(`unknown platform "${key}"; skipping`);
  process.exit(0);
}
log(`platform: ${key}`);

const loadFindings = (path: string): Finding[] => {
  try {
    return parseFindings(JSON.parse(readFileSync(path, "utf8")));
  } catch (e) {
    log(`could not read findings JSON: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
};

const findings = loadFindings(reportPath);
const resolved = adapter.resolve(process.env);
await dispatch(resolved, findings, log);
