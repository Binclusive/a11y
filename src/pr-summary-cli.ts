/**
 * The thin CLI over the PR-summary rollup (issue #2132) that `entrypoint.sh`
 * invokes (through the root `pr-summary.mjs` tsx wrapper) after a scan.
 *
 * It does two independent, best-effort things:
 *
 *   1. Writes a GitHub Actions **job summary** ($GITHUB_STEP_SUMMARY) with the
 *      run's rollup — ALWAYS, even with no PR context (push / manual dispatch),
 *      so the run page shows the shape of the run.
 *   2. When a PR context + token are present, posts/updates the ONE rollup
 *      comment on the PR conversation — found by a stable marker and updated in
 *      place across pushes, never re-posted (the #2131 dedup discipline, one
 *      level up).
 *
 * Best-effort by design: any missing context, failed read, or failed API call is
 * logged to stderr and skipped — never thrown — so the calling entrypoint still
 * exits 0. The rollup posts through the Action's own `GITHUB_TOKEN` identity, the
 * same identity as the inline comments (no hardcoded bot — #2130's branded bot
 * carries it for free).
 *
 * Env: GITHUB_TOKEN, GITHUB_REPOSITORY ("owner/name"), PR_NUMBER, HEAD_SHA,
 *      GITHUB_STEP_SUMMARY, GITHUB_SERVER_URL, GITHUB_API_URL (all optional; the
 *      job summary needs only GITHUB_STEP_SUMMARY, the comment needs the PR set).
 */
import { appendFileSync, readFileSync } from "node:fs";
import { type Finding, parseFindings } from "./pr-comment";
import {
  computeRollup,
  type RenderOptions,
  renderJobSummary,
  type RollupClient,
  type RollupComment,
  syncRollupBestEffort,
} from "./pr-summary";

const reportPath = process.argv[2];
const log = (msg: string): void => console.error(`pr-summary: ${msg}`);

if (!reportPath) {
  log("no report path argument; skipping");
  process.exit(0);
}

const loadFindings = (path: string): Finding[] => {
  try {
    return parseFindings(JSON.parse(readFileSync(path, "utf8")));
  } catch (e) {
    log(`could not read findings JSON: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
};
const findings = loadFindings(reportPath);

const repo = process.env.GITHUB_REPOSITORY;
const headSha = process.env.HEAD_SHA;
const serverUrl = process.env.GITHUB_SERVER_URL || "https://github.com";

// Link each finding to its changed file at the run's head sha — the same local
// navigation the inline comments anchor on, not a wire-crossing source snippet.
const linkFor: RenderOptions["linkFor"] =
  repo && headSha
    ? (f: Finding) => `${serverUrl}/${repo}/blob/${headSha}/${encodeURI(f.file)}#L${f.line}`
    : undefined;
const renderOpts: RenderOptions = linkFor ? { linkFor } : {};

// ---- 1. Job summary — always, even with no PR context ----------------------
const summaryPath = process.env.GITHUB_STEP_SUMMARY;
if (summaryPath) {
  try {
    const rollup = computeRollup(findings);
    appendFileSync(summaryPath, `${renderJobSummary(rollup, findings, renderOpts)}\n`);
    log("wrote job summary");
  } catch (e) {
    // Best-effort: a failed summary write must never fail the job.
    log(`job summary write failed (ignored): ${e instanceof Error ? e.message : String(e)}`);
  }
} else {
  log("no GITHUB_STEP_SUMMARY — skipping job summary");
}

// ---- 2. Rollup PR comment — only with a PR context -------------------------
const token = process.env.GITHUB_TOKEN;
const pr = process.env.PR_NUMBER;
const api = process.env.GITHUB_API_URL || "https://api.github.com";

if (!token || !repo || !pr) {
  log("no PR context/token — skipping rollup comment");
  process.exit(0);
}

const headers: Record<string, string> = {
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "binclusive-a11y-agent",
  "Content-Type": "application/json",
};

/**
 * GitHub REST implementation over the PR-conversation (issue) comments endpoints
 * — distinct from the inline review-comment endpoints the per-finding reconciler
 * uses. `list` fetches a COMPLETE view or throws (a partial view could re-CREATE
 * an existing rollup on an unfetched page); create/update/remove are best-effort.
 */
const client: RollupClient = {
  async list(): Promise<RollupComment[]> {
    const out: RollupComment[] = [];
    for (let page = 1; ; page++) {
      const url = `${api}/repos/${repo}/issues/${pr}/comments?per_page=100&page=${page}`;
      let res: Response;
      try {
        res = await fetch(url, { headers });
      } catch (e) {
        throw new Error(`list page ${page} fetch failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (!res.ok) {
        throw new Error(`list page ${page} -> ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
      }
      let batch: unknown;
      try {
        batch = await res.json();
      } catch (e) {
        throw new Error(`list page ${page} JSON parse failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (!Array.isArray(batch) || batch.length === 0) break;
      for (const c of batch) {
        if (c && typeof c === "object" && typeof (c as { id?: unknown }).id === "number" && typeof (c as { body?: unknown }).body === "string") {
          out.push({ id: (c as { id: number }).id, body: (c as { body: string }).body });
        }
      }
      if (batch.length < 100) break;
    }
    return out;
  },

  async create(body: string): Promise<void> {
    const url = `${api}/repos/${repo}/issues/${pr}/comments`;
    try {
      const res = await fetch(url, { method: "POST", headers, body: JSON.stringify({ body }) });
      if (!res.ok) log(`create rollup -> ${res.status} ${(await res.text()).slice(0, 200)}`);
    } catch (e) {
      log(`create rollup failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },

  async update(id: number, body: string): Promise<void> {
    const url = `${api}/repos/${repo}/issues/comments/${id}`;
    try {
      const res = await fetch(url, { method: "PATCH", headers, body: JSON.stringify({ body }) });
      if (!res.ok) log(`update rollup ${id} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
    } catch (e) {
      log(`update rollup ${id} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },

  async remove(id: number): Promise<void> {
    const url = `${api}/repos/${repo}/issues/comments/${id}`;
    try {
      const res = await fetch(url, { method: "DELETE", headers });
      if (!res.ok && res.status !== 404) log(`remove rollup ${id} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
    } catch (e) {
      log(`remove rollup ${id} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
};

// Best-effort by contract: syncRollupBestEffort swallows any throw (a partial-list
// abort, a mid-sync API error) so the entrypoint always exits 0 — the rollup is
// advisory and must never fail the CI job.
await syncRollupBestEffort(findings, client, renderOpts, log);
