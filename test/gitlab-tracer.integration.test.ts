import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { buildJsonReport } from "../src/cli";
import { scan } from "../src/core";
import { enrichAll } from "../src/evidence";
import { dispatch, parseFindings, resolvePlatformKey } from "../src/reporter/contract";
import { defaultRegistry } from "../src/reporter/registry";

/**
 * The GitLab vertical tracer (#214) — the CONNECTED-seam proof, not a per-adapter
 * unit test. It drives the FULL assembled path a real MR pipeline runs, exactly as
 * `src/reporter-cli.ts` wires it after `entrypoint.sh`'s scan:
 *
 *   GitLab CI env → gitlab RESOLVER (post-target) ┐
 *   real engine SCAN of the fixture .tsx          ├→ parseFindings → DISPATCH
 *   (scan → enrichAll → buildJsonReport → JSON)   ┘   → gitlab REPORTER → MR-note POST
 *
 * This is the ".patterns/reviews" guard: every adapter unit test in
 * `reporter-adapter.test.ts` can pass while the assembled path never runs. Here the
 * finding is NOT hand-built — it is produced by the real engine scanning the fixture
 * (`experiments/gitlab-tracer/fixture/src/Hero.tsx`, an <img> with no alt), so we
 * prove the finding traverses the whole seam into the MR-note payload. `fetch` is a
 * RECORDED GitLab API via `vi.stubGlobal` (repo convention — see reporter-adapter.test.ts).
 *
 * AC1/AC3 of #214 — a REAL pipeline URL + a screenshot of the native MR note — are
 * OUTWARD, human-gated, and cannot be faked here; they stay open per the README.
 * This test discharges the buildable half: the connected seam holds in-process.
 */

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(here, "..", "experiments", "gitlab-tracer", "fixture");
const FIXTURE_TSX = join(FIXTURE_ROOT, "src", "Hero.tsx");

/**
 * Run the ACTUAL engine over the fixture and project it through the same
 * `buildJsonReport` the CLI's `check --json` emits, then serialize→parse to mirror
 * `reporter-cli.ts` reading the findings JSON off disk. The returned value is the
 * canonical contract findings the reporter consumes — a real scan, never a literal.
 */
async function scanFixtureFindings(): Promise<ReturnType<typeof parseFindings>> {
  const result = await scan([FIXTURE_TSX]);
  const report = buildJsonReport(FIXTURE_ROOT, 1, result.coverage, enrichAll(result.findings));
  // The disk round-trip a real run does (entrypoint writes the report, reporter-cli
  // reads it): JSON.parse of the serialized report, then the boundary parse.
  return parseFindings(JSON.parse(JSON.stringify(report)));
}

/** A GitLab merge_request pipeline env: complete MR context + an api-scoped token. */
const MR_ENV: NodeJS.ProcessEnv = {
  A11Y_PLATFORM: "gitlab",
  CI_PROJECT_ID: "1042",
  CI_MERGE_REQUEST_IID: "7",
  CI_API_V4_URL: "https://gitlab.example.com/api/v4",
  A11Y_GITLAB_TOKEN: "glpat-tracer",
};

const noLog = (): void => {};

describe("GitLab vertical tracer (#214) — the connected seam, end to end", () => {
  it("drives GitLab CI env → real scan → dispatch → gitlab reporter → MR note POST, and the real finding reaches the note", async () => {
    // 1. The real engine finds the fixture's known regression (not a hand-built finding).
    const findings = await scanFixtureFindings();
    expect(findings.length).toBeGreaterThan(0);
    const alt = findings.find((f) => f.ruleId === "jsx-a11y/alt-text");
    expect(alt, "the fixture must produce the known jsx-a11y/alt-text finding").toBeDefined();
    expect(alt?.file).toBe("src/Hero.tsx"); // root-relative, as buildJsonReport emits

    // 2. Record GitLab's API: list `/notes` returns an EMPTY page (no prior marker note),
    //    forcing the POST-create path; capture the POST body (the MR note).
    const calls: { url: string; method: string; body?: string }[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ url: String(url), method, ...(init?.body ? { body: String(init.body) } : {}) });
      if (method === "GET") return new Response("[]", { status: 200 }); // no existing notes
      return new Response("{}", { status: 201 }); // created
    });
    vi.stubGlobal("fetch", fetchMock);

    // 3. Drive the SAME assembled path reporter-cli.ts runs: resolve platform key →
    //    select the gitlab adapter from the default registry → resolve the MR
    //    post-target from env → dispatch the real findings. No throw ⇒ advisory exit-0.
    let threw = false;
    try {
      const key = resolvePlatformKey(MR_ENV);
      expect(key).toBe("gitlab"); // the CI env selected the gitlab adapter, not the default github
      const adapter = defaultRegistry().select(key);
      expect(adapter).toBeDefined();
      const resolved = adapter!.resolve(MR_ENV);
      expect(resolved.report, "a complete MR context + token must yield a live reporter").not.toBeNull();
      await dispatch(resolved, findings, noLog);
    } catch {
      threw = true;
    } finally {
      vi.unstubAllGlobals();
    }
    expect(threw).toBe(false);

    // 4. ASSERT the finding traversed the WHOLE path into the MR-note payload.
    const post = calls.find((c) => c.method === "POST");
    expect(post, "the reporter must POST a new MR note when none exists").toBeDefined();
    expect(post?.url).toBe("https://gitlab.example.com/api/v4/projects/1042/merge_requests/7/notes");
    const noteBody = (JSON.parse(post!.body!) as { body: string }).body;
    // rule id, file:line, and message all reached the note — the connected-seam proof.
    // The `file:line` is read back off the very finding the scan produced (never a
    // hardcoded literal), so a fixture edit can't silently pass this assertion.
    expect(noteBody).toContain("**jsx-a11y/alt-text**");
    expect(noteBody).toContain(`\`${alt!.file}:${alt!.line}\``);
    expect(noteBody).toContain("alt text");
    expect(noteBody).toContain("<!-- binclusive-a11y-mr-summary -->"); // reconcile marker present
  });

  it("UPDATEs its own prior note in place (PUT) when a marker note already exists — the dedupe path over the same assembled seam", async () => {
    const findings = await scanFixtureFindings();
    const marker = "<!-- binclusive-a11y-mr-summary -->";
    const methods: string[] = [];
    let putUrl: string | undefined;
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      methods.push(method);
      if (method === "GET") {
        // a prior summary note from us is already on the MR ⇒ force the PUT-dedupe path
        return new Response(JSON.stringify([{ id: 555, body: `old summary\n\n${marker}` }]), { status: 200 });
      }
      if (method === "PUT") putUrl = String(url);
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const adapter = defaultRegistry().select(resolvePlatformKey(MR_ENV));
      await dispatch(adapter!.resolve(MR_ENV), findings, noLog);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(methods).not.toContain("POST"); // no duplicate note created
    expect(putUrl).toBe("https://gitlab.example.com/api/v4/projects/1042/merge_requests/7/notes/555");
  });

  it("no-ops WITHOUT posting when there is no MR context — the advisory opt-in default holds over the assembled path", async () => {
    const findings = await scanFixtureFindings();
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    let threw = false;
    try {
      // A plain branch pipeline: no CI_MERGE_REQUEST_IID ⇒ the resolver yields no
      // post-target ⇒ the bound reporter is null ⇒ dispatch no-ops. Findings still exist.
      const branchEnv: NodeJS.ProcessEnv = { A11Y_PLATFORM: "gitlab", CI_PROJECT_ID: "1042", A11Y_GITLAB_TOKEN: "glpat-tracer" };
      const adapter = defaultRegistry().select(resolvePlatformKey(branchEnv));
      const resolved = adapter!.resolve(branchEnv);
      expect(resolved.report).toBeNull();
      await dispatch(resolved, findings, noLog);
    } catch {
      threw = true;
    } finally {
      vi.unstubAllGlobals();
    }
    expect(threw).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled(); // no note POSTed with no MR context
  });
});
