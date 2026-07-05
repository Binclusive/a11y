/**
 * The thin CLI over {@link syncComments} that `entrypoint.sh` invokes (through
 * the root `pr-comment.mjs` tsx wrapper) to post inline PR review comments.
 *
 * Best-effort by design: any missing context, failed read, or failed API call is
 * logged to stderr and skipped — never thrown — so the calling entrypoint still
 * exits 0. Authenticates to the GitHub REST API with the Action's `GITHUB_TOKEN`.
 *
 * De-duplicating (issue #2131): instead of POSTing every finding on every push,
 * it reconciles against the comments already on the PR — updating a finding's
 * comment in place, creating only brand-new findings, and deleting the comments
 * of findings that have since been fixed. Re-running converges to one comment
 * per finding rather than accumulating duplicates.
 *
 * Env: GITHUB_TOKEN, GITHUB_REPOSITORY ("owner/name"), PR_NUMBER, HEAD_SHA,
 *      GITHUB_API_URL (optional, defaults to the public API).
 */
import { readFileSync } from "node:fs";
import {
  type Finding,
  parseFindings,
  type PrCommentClient,
  renderBody,
  type ReviewComment,
  syncCommentsBestEffort,
} from "./pr-comment";

const reportPath = process.argv[2];
const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;
const pr = process.env.PR_NUMBER;
const commitId = process.env.HEAD_SHA;
const api = process.env.GITHUB_API_URL || "https://api.github.com";

const log = (msg: string): void => console.error(`pr-comment: ${msg}`);
const bail = (msg: string): never => {
  log(msg);
  process.exit(0); // never fatal — the gate is advisory
};

if (!reportPath) bail("no report path argument; skipping");
if (!token || !repo || !pr || !commitId) bail("missing PR context; skipping");

const loadFindings = (path: string): Finding[] => {
  try {
    return parseFindings(JSON.parse(readFileSync(path, "utf8")));
  } catch (e) {
    return bail(`could not read findings JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
};
const findings = loadFindings(reportPath);

const headers: Record<string, string> = {
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "binclusive-a11y-agent",
  "Content-Type": "application/json",
};

/**
 * GitHub REST implementation of the reconcile client. Inline review comments
 * live under two endpoints: the PR-scoped collection (list + create) and the
 * repo-scoped single-comment resource (update + delete). Every call is
 * best-effort — a failure is logged and swallowed so one bad comment never
 * aborts the rest of the sync.
 */
const client: PrCommentClient = {
  async list(): Promise<ReviewComment[]> {
    const out: ReviewComment[] = [];
    for (let page = 1; ; page++) {
      const url = `${api}/repos/${repo}/pulls/${pr}/comments?per_page=100&page=${page}`;
      let res: Response;
      // A page failure must ABORT the whole sync (throw), not `break` with a
      // partial list: reconciling against a truncated view reads comments on the
      // unfetched pages as absent and re-CREATEs them → duplicates, exactly on
      // large PRs where dedup matters most. Better to skip this run entirely.
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
        // A 200 with an unparseable body is still an incomplete view → abort.
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

  async create(f: Finding): Promise<void> {
    // side:"RIGHT" anchors the comment on the head (post-change) version of the
    // file — the line only exists there when it is part of the PR diff.
    const payload = { body: renderBody(f), commit_id: commitId, path: f.file, line: f.line, side: "RIGHT" };
    const url = `${api}/repos/${repo}/pulls/${pr}/comments`;
    try {
      const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload) });
      if (!res.ok) log(`create ${f.file}:${f.line} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
    } catch (e) {
      log(`create failed for ${f.file}:${f.line}: ${e instanceof Error ? e.message : String(e)}`);
    }
  },

  async update(id: number, f: Finding): Promise<void> {
    const url = `${api}/repos/${repo}/pulls/comments/${id}`;
    try {
      const res = await fetch(url, { method: "PATCH", headers, body: JSON.stringify({ body: renderBody(f) }) });
      if (!res.ok) log(`update ${id} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
    } catch (e) {
      log(`update failed for comment ${id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  },

  async remove(id: number): Promise<void> {
    const url = `${api}/repos/${repo}/pulls/comments/${id}`;
    try {
      const res = await fetch(url, { method: "DELETE", headers });
      if (!res.ok && res.status !== 404) log(`remove ${id} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
    } catch (e) {
      log(`remove failed for comment ${id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
};

// Best-effort by contract: syncCommentsBestEffort swallows any throw (a
// partial-list abort, a mid-sync API error) so the entrypoint always exits 0 —
// comment de-dup is advisory and must never fail the CI job.
await syncCommentsBestEffort(findings, client, log);
