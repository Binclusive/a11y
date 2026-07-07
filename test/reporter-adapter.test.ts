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
  it("selects the shipped github + null adapters, undefined for unknown", () => {
    const reg = defaultRegistry();
    expect(reg.select("github")?.key).toBe("github");
    expect(reg.select("null")?.key).toBe("null");
    expect(reg.select("buildkite")).toBeUndefined();
    expect(reg.keys().sort()).toEqual(["github", "null"]);
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
