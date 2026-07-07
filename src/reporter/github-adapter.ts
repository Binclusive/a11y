/**
 * The GitHub platform adapter — the FIRST adapter behind the reporter seam
 * (issue #2235). It is the existing inline PR-comment behavior refactored to fit
 * the contract, so the shipped Action is byte-for-byte behavior-preserving:
 *
 *   - the RESOLVER reads the same `GITHUB_REPOSITORY` / `PR_NUMBER` / `HEAD_SHA` /
 *     `GITHUB_API_URL` env `entrypoint.sh` exports (from `GITHUB_EVENT_PATH`) and
 *     the same `CHANGED_FILES` / `BASE_SHA` / `HEAD_SHA` diff scope, and
 *   - the REPORTER is the former `pr-comment-cli.ts` body: it resolves the posting
 *     identity (branded App, else `GITHUB_TOKEN` — issue #2130) and reconciles the
 *     PR's inline review comments through {@link syncCommentsBestEffort} (#2131).
 *
 * Opt-in: the resolver yields a `null` post-target — so the reporter no-ops — when
 * the PR context is incomplete OR no credential is present (no `GITHUB_TOKEN` and
 * no App configured), matching the old `entrypoint.sh` skip guard.
 */
import { scopeChangedTsxFromEnv } from "../diff-scope";
import { resolvePostingToken } from "../github-identity";
import {
  type Finding,
  type PrCommentClient,
  renderBody,
  type ReviewComment,
  syncCommentsBestEffort,
} from "../pr-comment";
import type { DiffContext, DiffContextResolver, FindingsReporter, Logger, PlatformAdapter } from "./contract";

/** The GitHub-native surface an inline review comment posts to. */
export interface GithubPostTarget {
  /** `owner/name`, from `GITHUB_REPOSITORY`. */
  readonly repo: string;
  /** The PR number, from `PR_NUMBER`. */
  readonly pr: string;
  /** The head commit the RIGHT-side comment anchors on, from `HEAD_SHA`. */
  readonly commitId: string;
  /** The GitHub REST base (public API, or a GHES host). */
  readonly api: string;
  /**
   * The process env the reporter resolves its posting token from — the branded
   * App credentials (`BINCLUSIVE_APP_*`) or the Action's `GITHUB_TOKEN`. Carried
   * on the target so token resolution (an async mint) stays in the reporter half.
   */
  readonly env: NodeJS.ProcessEnv;
}

const nonEmpty = (v: string | undefined): v is string => v !== undefined && v !== "";

/** True when SOME posting credential is present — a token or a configured App. */
function hasCredential(env: NodeJS.ProcessEnv): boolean {
  if (nonEmpty(env.GITHUB_TOKEN)) return true;
  return nonEmpty(env.BINCLUSIVE_APP_ID) && nonEmpty(env.BINCLUSIVE_APP_PRIVATE_KEY);
}

/** Resolve the GitHub change-context: changed `.tsx` + a post-target, or `null` when no PR context/credential. */
export const githubResolver: DiffContextResolver<GithubPostTarget> = {
  resolve(env): DiffContext<GithubPostTarget> {
    const changedTsx = scopeChangedTsxFromEnv(env);
    const repo = env.GITHUB_REPOSITORY;
    const pr = env.PR_NUMBER;
    const commitId = env.HEAD_SHA;
    // Opt-in: a complete PR context AND a credential are both required to post —
    // otherwise no target, so the reporter no-ops (the old entrypoint skip guard).
    if (!nonEmpty(repo) || !nonEmpty(pr) || !nonEmpty(commitId) || !hasCredential(env)) {
      return { changedTsx, postTarget: null };
    }
    const api = nonEmpty(env.GITHUB_API_URL) ? env.GITHUB_API_URL : "https://api.github.com";
    return { changedTsx, postTarget: { repo, pr, commitId, api, env } };
  },
};

/**
 * Build the GitHub REST reconcile client for a resolved target. Inline review
 * comments live under two endpoints: the PR-scoped collection (list + create) and
 * the repo-scoped single-comment resource (update + delete). Every call is
 * best-effort — a failure is logged and swallowed so one bad comment never aborts
 * the sync.
 */
function makeClient(target: GithubPostTarget, token: string, log: Logger): PrCommentClient {
  const { repo, pr, commitId, api } = target;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "binclusive-a11y-agent",
    "Content-Type": "application/json",
  };
  return {
    async list(): Promise<ReviewComment[]> {
      const out: ReviewComment[] = [];
      for (let page = 1; ; page++) {
        const url = `${api}/repos/${repo}/pulls/${pr}/comments?per_page=100&page=${page}`;
        let res: Response;
        // A page failure must ABORT the whole sync (throw), not `break` with a
        // partial list: reconciling against a truncated view reads comments on the
        // unfetched pages as absent and re-CREATEs them → duplicates.
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
          if (
            c &&
            typeof c === "object" &&
            typeof (c as { id?: unknown }).id === "number" &&
            typeof (c as { body?: unknown }).body === "string"
          ) {
            const user = (c as { user?: unknown }).user;
            const author =
              user && typeof user === "object" && typeof (user as { login?: unknown }).login === "string"
                ? (user as { login: string }).login
                : undefined;
            out.push({
              id: (c as { id: number }).id,
              body: (c as { body: string }).body,
              ...(author !== undefined ? { author } : {}),
            });
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
}

/** Post inline PR review comments, de-duplicating across pushes (the #2131 reconcile). */
export const githubReporter: FindingsReporter<GithubPostTarget> = {
  async report(findings, target, log): Promise<void> {
    // Resolve WHO posts once: branded App identity when configured, else GITHUB_TOKEN.
    // Never throws — a mint failure degrades to the default token.
    const { token, identity } = await resolvePostingToken(target.env, { repo: target.repo, api: target.api }, log);
    if (!token) {
      log("no posting token (no GitHub App configured and no GITHUB_TOKEN); skipping");
      return;
    }
    log(`posting inline comments as ${identity}`);
    const client = makeClient(target, token, log);
    // The author guard needs the login our comments carry. GITHUB_TOKEN posts as
    // `github-actions[bot]` (statically known); the branded App's bot login is not
    // known here, so leave `self` undefined for it — the guard degrades to
    // marker-only rather than risk skipping our own App-authored comments.
    const self = identity === "github-actions" ? "github-actions[bot]" : undefined;
    // Best-effort by contract: swallows any throw so the entrypoint always exits 0.
    await syncCommentsBestEffort(findings, client, log, self);
  },
};

/** The GitHub adapter: the diff-context resolver + the inline-comment reporter, keyed `github`. */
export const githubAdapter: PlatformAdapter<GithubPostTarget> = {
  key: "github",
  resolver: githubResolver,
  reporter: githubReporter,
};
