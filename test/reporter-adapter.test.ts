import { describe, expect, it, vi } from "vitest";
import {
  AdapterRegistry,
  bindAdapter,
  DEFAULT_PLATFORM_KEY,
  type DiffContext,
  dispatch,
  type Finding,
  type FindingsReporter,
  parseFindings,
  type PlatformAdapter,
  resolvePlatformKey,
} from "../src/reporter/contract";
import { githubAdapter, githubResolver } from "../src/reporter/github-adapter";
import { gitlabAdapter, gitlabResolver, renderMrNote } from "../src/reporter/gitlab-adapter";
import { makeNullAdapter, nullAdapter, renderLine } from "../src/reporter/null-adapter";
import { defaultRegistry } from "../src/reporter/registry";

/**
 * The reporter-adapter seam (issue #2235). Two halves — a diff-context resolver
 * and a findings reporter — behind one contract, with GitHub as the first adapter
 * and a null/stdout adapter proving the seam holds ≥ 2 platforms. These tests lock
 * dispatch (right adapter selected, canonical findings delivered, no-op on missing
 * post-context) and the ≥ 2 proof (two DIFFERENT post-target types in one registry).
 */

const noLog = (): void => {};

const finding = (over: Partial<Finding> = {}): Finding => ({
  ruleId: "image-alt",
  file: "src/App.tsx",
  line: 12,
  message: "Image missing alt text.",
  wcag: ["1.1.1"],
  impact: "critical",
  ...over,
});

/** A fake adapter over an arbitrary Ctx that records what its reporter received. */
function fakeAdapter<Ctx>(
  key: string,
  postTarget: Ctx | null,
  seen: { findings?: readonly Finding[]; target?: Ctx },
): PlatformAdapter<Ctx> {
  const resolver = { resolve: (): DiffContext<Ctx> => ({ changedTsx: [], postTarget }) };
  const reporter: FindingsReporter<Ctx> = {
    async report(findings, target): Promise<void> {
      seen.findings = findings;
      seen.target = target;
    },
  };
  return { key, resolver, reporter };
}

describe("resolvePlatformKey", () => {
  it("defaults to github", () => {
    expect(resolvePlatformKey({})).toBe("github");
    expect(DEFAULT_PLATFORM_KEY).toBe("github");
  });
  it("honors A11Y_PLATFORM, and an explicit override wins over env", () => {
    expect(resolvePlatformKey({ A11Y_PLATFORM: "null" })).toBe("null");
    expect(resolvePlatformKey({ A11Y_PLATFORM: "null" }, "github")).toBe("github");
    expect(resolvePlatformKey({ A11Y_PLATFORM: "" })).toBe("github"); // empty falls through
  });
});

describe("AdapterRegistry — selection by explicit key", () => {
  it("selects the shipped github + null + gitlab adapters, undefined for unknown", () => {
    const reg = defaultRegistry();
    expect(reg.select("github")?.key).toBe("github");
    expect(reg.select("null")?.key).toBe("null");
    expect(reg.select("gitlab")?.key).toBe("gitlab");
    expect(reg.select("buildkite")).toBeUndefined();
    expect(reg.keys().sort()).toEqual(["github", "gitlab", "null"]);
  });
});

describe("dispatch — the reporter receives the canonical contract shape", () => {
  it("selects the adapter and delivers the parsed findings to its reporter", async () => {
    const seen: { findings?: readonly Finding[]; target?: { id: number } } = {};
    const reg = new AdapterRegistry([bindAdapter(fakeAdapter("x", { id: 7 }, seen))]);
    const findings = [finding()];
    const bound = reg.select("x");
    expect(bound).toBeDefined();
    const resolved = bound!.resolve({});
    await dispatch(resolved, findings, noLog);
    expect(seen.findings).toEqual(findings); // canonical Finding[] delivered unchanged
    expect(seen.target).toEqual({ id: 7 });
  });

  it("no-ops WITHOUT error when the resolver yields no post-target", async () => {
    const seen: { findings?: readonly Finding[] } = {};
    const reg = new AdapterRegistry([bindAdapter(fakeAdapter("x", null, seen))]);
    const resolved = reg.select("x")!.resolve({});
    expect(resolved.report).toBeNull(); // report null ⇒ the bound reporter is never built
    await expect(dispatch(resolved, [finding()], noLog)).resolves.toBeUndefined();
    expect(seen.findings).toBeUndefined(); // reporter never invoked
  });
});

describe("the seam holds ≥ 2 platforms — two DIFFERENT post-target types in one registry", () => {
  it("routes the canonical findings to whichever adapter is selected, no shared Ctx", async () => {
    const seenA: { findings?: readonly Finding[]; target?: { kind: "a"; id: number } } = {};
    const seenB: { findings?: readonly Finding[]; target?: { kind: "b"; label: string } } = {};
    // Ctx types are structurally incompatible; bindAdapter erases both into one registry.
    const reg = new AdapterRegistry([
      bindAdapter(fakeAdapter("alpha", { kind: "a" as const, id: 1 }, seenA)),
      bindAdapter(fakeAdapter("beta", { kind: "b" as const, label: "z" }, seenB)),
    ]);
    const findings = [finding()];

    await dispatch(reg.select("alpha")!.resolve({}), findings, noLog);
    await dispatch(reg.select("beta")!.resolve({}), findings, noLog);

    expect(seenA.target).toEqual({ kind: "a", id: 1 });
    expect(seenB.target).toEqual({ kind: "b", label: "z" });
    expect(seenA.findings).toEqual(findings);
    expect(seenB.findings).toEqual(findings);
  });
});

describe("github adapter — resolver (the first adapter's diff-context half)", () => {
  const base = {
    GITHUB_REPOSITORY: "acme/app",
    PR_NUMBER: "42",
    HEAD_SHA: "deadbeef",
    GITHUB_TOKEN: "ghs_x",
    CHANGED_FILES: "src/A.tsx src/b.ts src/C.tsx",
  } satisfies NodeJS.ProcessEnv;

  it("yields a post-target + the changed .tsx when a PR context + credential are present", () => {
    const ctx = githubResolver.resolve(base);
    expect(ctx.changedTsx).toEqual(["src/A.tsx", "src/C.tsx"]);
    expect(ctx.postTarget).toMatchObject({ repo: "acme/app", pr: "42", commitId: "deadbeef", api: "https://api.github.com" });
  });

  it("no post-target (⇒ no-op) when the PR context is incomplete", () => {
    expect(githubResolver.resolve({ ...base, PR_NUMBER: undefined }).postTarget).toBeNull();
    expect(githubResolver.resolve({ ...base, GITHUB_REPOSITORY: undefined }).postTarget).toBeNull();
    expect(githubResolver.resolve({ ...base, HEAD_SHA: undefined }).postTarget).toBeNull();
  });

  it("no post-target when NO credential is present (no token, no App)", () => {
    expect(githubResolver.resolve({ ...base, GITHUB_TOKEN: undefined }).postTarget).toBeNull();
  });

  it("accepts branded-App credentials as the credential", () => {
    const env = { ...base, GITHUB_TOKEN: undefined, BINCLUSIVE_APP_ID: "1", BINCLUSIVE_APP_PRIVATE_KEY: "-----KEY-----" };
    expect(githubResolver.resolve(env).postTarget).not.toBeNull();
  });

  it("is registered as the shipped `github` adapter", () => {
    expect(githubAdapter.key).toBe("github");
  });
});

describe("null adapter — the ≥ 2 proof, generic stdout reporter", () => {
  it("renders a finding as one line", () => {
    expect(renderLine(finding())).toBe("src/App.tsx:12 critical: image-alt [WCAG 1.1.1] — Image missing alt text.");
  });

  it("always has a post-target (a sink is always available) and writes every finding", async () => {
    const lines: string[] = [];
    const adapter = makeNullAdapter((line) => lines.push(line));
    const resolved = bindAdapter(adapter).resolve({});
    expect(resolved.report).not.toBeNull();
    await dispatch(resolved, [finding(), finding({ file: "src/B.tsx", line: 3 })], noLog);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("src/App.tsx:12");
    expect(lines[1]).toContain("src/B.tsx:3");
  });

  it("is exported as the default `null` adapter", () => {
    expect(nullAdapter.key).toBe("null");
  });
});

describe("parseFindings — the canonical reporter input (re-exported by the seam)", () => {
  it("narrows the engine report JSON to Finding[], dropping malformed entries", () => {
    const parsed = parseFindings({
      findings: [
        { ruleId: "image-alt", file: "src/A.tsx", line: 4, message: "m", wcag: ["1.1.1"], impact: "critical" },
        { ruleId: "no-line" }, // dropped — no numeric line
      ],
    });
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ ruleId: "image-alt", file: "src/A.tsx", line: 4, impact: "critical" });
  });
});

describe("github reporter — no-op path (belt-and-suspenders with the resolver)", () => {
  it("skips without throwing when no token resolves", async () => {
    const log = vi.fn();
    // A target whose env carries no credential ⇒ resolvePostingToken returns "" ⇒ skip.
    await expect(
      githubAdapter.reporter.report([finding()], { repo: "a/b", pr: "1", commitId: "h", api: "https://api.github.com", env: {} }, log),
    ).resolves.toBeUndefined();
  });
});

describe("github reporter — a 422 create (line outside diff hunk) falls back, never a phantom success (#207)", () => {
  it("logs the finding as an out-of-hunk fallback, NOT as a created comment, when the create POST 422s", async () => {
    const logs: string[] = [];
    // Mock the GitHub REST API: the list GET returns an empty page (nothing on the PR
    // yet), the create POST 422s with GitHub's real out-of-hunk message.
    const fetchMock = vi.fn((url: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (method === "GET") return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
      if (method === "POST") {
        const body = JSON.stringify({
          message: "Validation Failed",
          errors: [{ resource: "PullRequestReviewComment", field: "line", code: "unprocessable" }],
          documentation_url: "https://docs.github.com/rest/pulls/comments#create-a-review-comment-for-a-pull-request",
        });
        // the diagnostic string the issue quoted: the line could not be resolved
        return Promise.resolve(
          new Response(`${body} pull_request_review_thread.line could not be resolved`, { status: 422 }),
        );
      }
      return Promise.resolve(new Response("", { status: 200 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const f = finding({ file: "src/Hero.tsx", line: 10 });
      await githubAdapter.reporter.report(
        [f],
        // GITHUB_TOKEN only ⇒ resolvePostingToken returns it directly (no network mint)
        { repo: "acme/app", pr: "42", commitId: "deadbeef", api: "https://api.github.com", env: { GITHUB_TOKEN: "ghs_x" } },
        (m) => logs.push(m),
      );
    } finally {
      vi.unstubAllGlobals();
    }

    // the create POST was attempted (in-hunk posting behavior is unchanged)
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/acme/app/pulls/42/comments",
      expect.objectContaining({ method: "POST" }),
    );
    // the misleading success log is gone: a 422 is never logged as a created comment
    expect(logs.some((m) => m.startsWith("created comment for"))).toBe(false);
    // it IS surfaced honestly — the adapter's 422 diagnostic and the sync's fallback line
    expect(logs.some((m) => m.includes("422") && m.toLowerCase().includes("line outside diff hunk"))).toBe(true);
    expect(logs.some((m) => m.includes("could not inline"))).toBe(true);
    // and the run summary counts zero created, one not inlined — the finding is not lost
    expect(logs.some((m) => m.startsWith("sync: 0 created") && m.includes("1 not inlined"))).toBe(true);
  });
});

describe("gitlab adapter — the sibling behind the seam (issue #213)", () => {
  const mrEnv = {
    CI_PROJECT_ID: "42",
    CI_MERGE_REQUEST_IID: "7",
    CI_API_V4_URL: "https://gitlab.example.com/api/v4",
    A11Y_GITLAB_TOKEN: "glpat-x",
    CHANGED_FILES: "src/A.tsx src/b.ts src/C.tsx",
  } satisfies NodeJS.ProcessEnv;

  it("is registered as the shipped `gitlab` adapter", () => {
    expect(gitlabAdapter.key).toBe("gitlab");
  });

  describe("resolver — the MR diff-context half", () => {
    it("yields a post-target + the changed .tsx when an MR context + credential are present", () => {
      const ctx = gitlabResolver.resolve(mrEnv);
      expect(ctx.changedTsx).toEqual(["src/A.tsx", "src/C.tsx"]);
      expect(ctx.postTarget).toMatchObject({
        projectId: "42",
        mrIid: "7",
        api: "https://gitlab.example.com/api/v4",
        token: "glpat-x",
        tokenHeader: "PRIVATE-TOKEN",
      });
    });

    it("derives the v4 base from CI_SERVER_URL, and CI_JOB_TOKEN is the JOB-TOKEN fallback", () => {
      const ctx = gitlabResolver.resolve({
        CI_PROJECT_ID: "1",
        CI_MERGE_REQUEST_IID: "2",
        CI_SERVER_URL: "https://gitlab.example.com/",
        CI_JOB_TOKEN: "job-tok",
      });
      expect(ctx.postTarget).toMatchObject({ api: "https://gitlab.example.com/api/v4", token: "job-tok", tokenHeader: "JOB-TOKEN" });
    });

    it("no post-target (⇒ no-op) when the MR context is incomplete", () => {
      expect(gitlabResolver.resolve({ ...mrEnv, CI_MERGE_REQUEST_IID: undefined }).postTarget).toBeNull();
      expect(gitlabResolver.resolve({ ...mrEnv, CI_PROJECT_ID: undefined }).postTarget).toBeNull();
    });

    it("no post-target when NO credential is present (no token, no CI_JOB_TOKEN)", () => {
      expect(gitlabResolver.resolve({ ...mrEnv, A11Y_GITLAB_TOKEN: undefined }).postTarget).toBeNull();
    });

    it("no-context env dispatches WITHOUT error — the opt-in no-op path end to end", async () => {
      // Incomplete MR env ⇒ null target ⇒ bound reporter is never built ⇒ dispatch no-ops.
      const resolved = bindAdapter(gitlabAdapter).resolve({ CHANGED_FILES: "src/A.tsx" });
      expect(resolved.report).toBeNull();
      await expect(dispatch(resolved, [finding()], noLog)).resolves.toBeUndefined();
    });
  });

  describe("renderMrNote — the findings→MR-note transform (canonical contract in → note body out)", () => {
    it("renders each finding with impact, rule, WCAG, message, and file:line, plus the reconcile marker", () => {
      const note = renderMrNote([finding(), finding({ ruleId: "label", file: "src/B.tsx", line: 3, wcag: ["4.1.2"], impact: "serious", message: "Control needs a label." })]);
      expect(note).toContain("found 2 accessibility finding(s)");
      expect(note).toContain("`critical` **image-alt** (WCAG 1.1.1) — Image missing alt text. — `src/App.tsx:12`");
      expect(note).toContain("`serious` **label** (WCAG 4.1.2) — Control needs a label. — `src/B.tsx:3`");
      expect(note).toContain("<!-- binclusive-a11y-mr-summary -->"); // marker enables in-place update on re-run
    });

    it("renders a clean pass for an empty finding set", () => {
      const note = renderMrNote([]);
      expect(note).toContain("no accessibility findings");
      expect(note).toContain("<!-- binclusive-a11y-mr-summary -->");
    });
  });

  describe("reporter — posts the note payload, best-effort", () => {
    const target = {
      projectId: "42",
      mrIid: "7",
      api: "https://gitlab.example.com/api/v4",
      token: "glpat-x",
      tokenHeader: "PRIVATE-TOKEN" as const,
    };

    it("POSTs the rendered note (no prior note) to the MR notes endpoint with the auth header", async () => {
      const calls: { url: string; init?: RequestInit }[] = [];
      const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), ...(init ? { init } : {}) });
        // list returns no existing note ⇒ the reporter creates one
        if (init?.method === undefined) return new Response("[]", { status: 200 });
        return new Response("{}", { status: 201 });
      });
      vi.stubGlobal("fetch", fetchMock);
      try {
        await gitlabAdapter.reporter.report([finding()], target, noLog);
      } finally {
        vi.unstubAllGlobals();
      }
      const post = calls.find((c) => c.init?.method === "POST");
      expect(post?.url).toBe("https://gitlab.example.com/api/v4/projects/42/merge_requests/7/notes");
      expect((post?.init?.headers as Record<string, string>)["PRIVATE-TOKEN"]).toBe("glpat-x");
      const sent = JSON.parse(String(post?.init?.body)) as { body: string };
      expect(sent.body).toContain("**image-alt**"); // the canonical finding reached the note payload
      expect(sent.body).toContain("`src/App.tsx:12`");
    });

    it("UPDATEs its own prior note in place (found by marker) rather than posting a duplicate", async () => {
      const marker = "<!-- binclusive-a11y-mr-summary -->";
      const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === undefined) return new Response(JSON.stringify([{ id: 99, body: `old\n\n${marker}` }]), { status: 200 });
        return new Response("{}", { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);
      let putUrl: string | undefined;
      try {
        await gitlabAdapter.reporter.report([finding()], target, noLog);
        putUrl = fetchMock.mock.calls.map(([u, i]) => (i?.method === "PUT" ? String(u) : "")).find((u) => u !== "");
      } finally {
        vi.unstubAllGlobals();
      }
      expect(putUrl).toBe("https://gitlab.example.com/api/v4/projects/42/merge_requests/7/notes/99");
    });

    it("swallows a failing API call — logs, never throws (advisory exit-0)", async () => {
      const log = vi.fn();
      vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
      try {
        await expect(gitlabAdapter.reporter.report([finding()], target, log)).resolves.toBeUndefined();
      } finally {
        vi.unstubAllGlobals();
      }
      expect(log).toHaveBeenCalled();
    });
  });
});
