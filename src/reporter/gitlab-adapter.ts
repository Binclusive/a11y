/**
 * The GitLab platform adapter — a sibling behind the reporter seam (issue #213),
 * added alongside `github` (#2235) and `null` without touching the contract. Its
 * two halves mirror the GitHub adapter's shape:
 *
 *   - the RESOLVER reads GitLab CI's MR context (`CI_PROJECT_ID` +
 *     `CI_MERGE_REQUEST_IID` identify the MR; `BASE_SHA` / `HEAD_SHA` — mapped from
 *     `CI_MERGE_REQUEST_DIFF_BASE_SHA` / `CI_COMMIT_SHA` in `.gitlab-ci.yml` — scope
 *     the changed `.tsx`), and
 *   - the REPORTER posts the canonical findings as a single reconciled MR note via
 *     the GitLab REST API (`/projects/:id/merge_requests/:iid/notes`).
 *
 * Opt-in by construction (the same discipline as the GitHub adapter): the resolver
 * yields a `null` post-target — so the reporter no-ops — when the MR context is
 * incomplete OR no API credential is present. Absent an MR pipeline the artifacts
 * still emit and the advisory gate still exits 0.
 */
import { scopeChangedTsxFromEnv } from "../diff-scope";
import type { DiffContext, DiffContextResolver, Finding, FindingsReporter, PlatformAdapter } from "./contract";

/**
 * The GitLab-native surface an MR note posts to. `token`/`tokenHeader` are carried
 * on the target because GitLab authorizes two ways: a project/personal access token
 * (`PRIVATE-TOKEN`) or the pipeline's `CI_JOB_TOKEN` (`JOB-TOKEN`) — the resolver
 * picks one and the reporter sends whichever header it chose.
 */
export interface GitlabPostTarget {
  /** The numeric or path-encoded project id, from `CI_PROJECT_ID`. */
  readonly projectId: string;
  /** The MR internal id (per-project), from `CI_MERGE_REQUEST_IID`. */
  readonly mrIid: string;
  /** The GitLab REST v4 base (gitlab.com or a self-managed host). */
  readonly api: string;
  /** The API credential value. */
  readonly token: string;
  /** Which auth header carries `token` — a project/personal token vs the CI job token. */
  readonly tokenHeader: "PRIVATE-TOKEN" | "JOB-TOKEN";
}

/** A hidden marker on our summary note so a re-run UPDATES it in place, never spamming a new note per push. */
const NOTE_MARKER = "<!-- binclusive-a11y-mr-summary -->";

const nonEmpty = (v: string | undefined): v is string => v !== undefined && v !== "";

/**
 * The REST v4 base: GitLab hands it directly as `CI_API_V4_URL`; else derive it
 * from the server URL; else the SaaS default. Self-managed hosts differ, so an
 * env-provided base always wins over the default.
 */
function resolveApiBase(env: NodeJS.ProcessEnv): string {
  // Strip a trailing slash on every branch: a `CI_API_V4_URL` with one would else
  // yield `…/api/v4//projects/…` once the reporter joins its `/projects/…` path.
  if (nonEmpty(env.CI_API_V4_URL)) return env.CI_API_V4_URL.replace(/\/+$/, "");
  if (nonEmpty(env.CI_SERVER_URL)) return `${env.CI_SERVER_URL.replace(/\/+$/, "")}/api/v4`;
  return "https://gitlab.com/api/v4";
}

/**
 * Resolve the posting credential. A project/personal access token
 * (`A11Y_GITLAB_TOKEN`/`GITLAB_TOKEN` → `PRIVATE-TOKEN`) is preferred because the
 * pipeline's `CI_JOB_TOKEN` has a narrower API surface that cannot always create MR
 * notes; `CI_JOB_TOKEN` (→ `JOB-TOKEN`) is the zero-config fallback. `null` ⇒ no
 * credential ⇒ the opt-in no-op.
 */
function resolveCredential(env: NodeJS.ProcessEnv): { token: string; tokenHeader: GitlabPostTarget["tokenHeader"] } | null {
  if (nonEmpty(env.A11Y_GITLAB_TOKEN)) return { token: env.A11Y_GITLAB_TOKEN, tokenHeader: "PRIVATE-TOKEN" };
  if (nonEmpty(env.GITLAB_TOKEN)) return { token: env.GITLAB_TOKEN, tokenHeader: "PRIVATE-TOKEN" };
  if (nonEmpty(env.CI_JOB_TOKEN)) return { token: env.CI_JOB_TOKEN, tokenHeader: "JOB-TOKEN" };
  return null;
}

/** Resolve the GitLab change-context: changed `.tsx` + a post-target, or `null` when no MR context/credential. */
export const gitlabResolver: DiffContextResolver<GitlabPostTarget> = {
  resolve(env): DiffContext<GitlabPostTarget> {
    const changedTsx = scopeChangedTsxFromEnv(env);
    const projectId = env.CI_PROJECT_ID;
    const mrIid = env.CI_MERGE_REQUEST_IID;
    const cred = resolveCredential(env);
    // Opt-in: a complete MR context AND a credential are both required to post —
    // otherwise no target, so the reporter no-ops (mirrors the GitHub adapter).
    if (!nonEmpty(projectId) || !nonEmpty(mrIid) || cred === null) {
      return { changedTsx, postTarget: null };
    }
    return { changedTsx, postTarget: { projectId, mrIid, api: resolveApiBase(env), token: cred.token, tokenHeader: cred.tokenHeader } };
  },
};

/**
 * Render the canonical findings into ONE MR-note markdown body — the platform's
 * findings→note transform. A hidden {@link NOTE_MARKER} trails the body so the
 * reporter can find and update its own note on the next push. An empty finding set
 * renders a clean pass.
 */
export function renderMrNote(findings: readonly Finding[]): string {
  if (findings.length === 0) {
    return `**Binclusive a11y** — no accessibility findings in the changed files.\n\n${NOTE_MARKER}`;
  }
  const rows = findings.map((f) => {
    const wcag = (f.wcag ?? []).map((s) => `WCAG ${s}`).join(", ");
    const impact = f.impact ? `\`${f.impact}\` ` : "";
    const tag = wcag !== "" ? ` (${wcag})` : "";
    return `- ${impact}**${f.ruleId}**${tag} — ${f.message} — \`${f.file}:${f.line}\``;
  });
  return `**Binclusive a11y** found ${findings.length} accessibility finding(s) in the changed files:\n\n${rows.join("\n")}\n\n${NOTE_MARKER}`;
}

/** Read our own summary note's id off a `/notes` list payload, or `null` if none exists yet. */
function findOwnNoteId(payload: unknown): number | null {
  if (!Array.isArray(payload)) return null;
  for (const n of payload) {
    if (
      n &&
      typeof n === "object" &&
      typeof (n as { id?: unknown }).id === "number" &&
      typeof (n as { body?: unknown }).body === "string" &&
      (n as { body: string }).body.includes(NOTE_MARKER)
    ) {
      return (n as { id: number }).id;
    }
  }
  return null;
}

/** Post the findings as one reconciled MR note. Best-effort: every failure is logged and swallowed, never thrown. */
export const gitlabReporter: FindingsReporter<GitlabPostTarget> = {
  async report(findings, target, log): Promise<void> {
    const { api, projectId, mrIid, token, tokenHeader } = target;
    const headers: Record<string, string> = {
      [tokenHeader]: token,
      "Content-Type": "application/json",
      "User-Agent": "binclusive-a11y-agent",
    };
    const notesUrl = `${api}/projects/${encodeURIComponent(projectId)}/merge_requests/${mrIid}/notes`;
    const body = renderMrNote(findings);

    // Reconcile: find our prior summary note so a re-run updates it in place. GitLab
    // paginates `/notes` at 100/page, so we page through ALL notes before concluding
    // the marker is absent — on an MR with >100 notes the marker falls off page 1, and
    // a single-page list would re-POST a duplicate instead of PUT-updating in place
    // (mirrors github-adapter's paginated `list()`). A failed or short page degrades to
    // "post a fresh note" — worst case a duplicate, never a throw.
    let existingId: number | null = null;
    try {
      for (let page = 1; existingId === null; page++) {
        const res = await fetch(`${notesUrl}?per_page=100&page=${page}`, { headers });
        if (!res.ok) {
          log(`gitlab: list MR notes p${page} -> ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
          break;
        }
        const batch = await res.json();
        existingId = findOwnNoteId(batch);
        // A short page (or a non-array/empty body) is the last page — stop paging.
        if (!Array.isArray(batch) || batch.length < 100) break;
      }
    } catch (e) {
      log(`gitlab: list MR notes failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    try {
      const res =
        existingId !== null
          ? await fetch(`${notesUrl}/${existingId}`, { method: "PUT", headers, body: JSON.stringify({ body }) })
          : await fetch(notesUrl, { method: "POST", headers, body: JSON.stringify({ body }) });
      if (res.ok) log(`gitlab: ${existingId !== null ? "updated" : "posted"} MR note on !${mrIid} (${findings.length} finding(s))`);
      else log(`gitlab: post MR note -> ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
    } catch (e) {
      log(`gitlab: post MR note failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
};

/** The GitLab adapter: the MR diff-context resolver + the MR-note reporter, keyed `gitlab`. */
export const gitlabAdapter: PlatformAdapter<GitlabPostTarget> = {
  key: "gitlab",
  resolver: gitlabResolver,
  reporter: gitlabReporter,
};
