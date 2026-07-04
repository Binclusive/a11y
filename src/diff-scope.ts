/**
 * Changed-file diff-scoping — the ONE shared module the engine and the CI Action
 * both import, replacing the ad-hoc `git diff | grep` shell that used to live
 * inline in `entrypoint.sh`. Contract-independent: it resolves WHICH `.tsx`
 * files a run should scan; it knows nothing about findings.
 *
 * Resolution order mirrors the tracer-bullet shell, highest priority first:
 *   1. an explicit `CHANGED_FILES` list (the caller already knows the diff),
 *   2. a `BASE..HEAD` git diff in the workspace,
 *   3. nothing — the caller falls back to a wholesale scan.
 */
import { execFileSync } from "node:child_process";

export interface DiffScopeInput {
  /** Explicit changed-file list (whitespace-split upstream), highest priority. */
  readonly changedFiles?: readonly string[];
  /** Base commit of the diff (git range lower bound). */
  readonly baseSha?: string;
  /** Head commit of the diff (git range upper bound). */
  readonly headSha?: string;
  /** Working tree the git diff runs against. */
  readonly workspace: string;
}

const TSX = /\.tsx$/;

/** Split a raw whitespace-separated `CHANGED_FILES` value into a path list. */
export function parseChangedFiles(raw: string): string[] {
  return raw.split(/\s+/).filter((p) => p !== "");
}

function isGitRepo(workspace: string): boolean {
  try {
    execFileSync("git", ["-C", workspace, "rev-parse", "--git-dir"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function gitDiffNames(workspace: string, baseSha: string, headSha: string): string[] {
  try {
    const out = execFileSync(
      "git",
      ["-C", workspace, "diff", "--name-only", `${baseSha}...${headSha}`],
      { encoding: "utf8" },
    );
    return out.split("\n").filter((p) => p !== "");
  } catch {
    // Advisory gate: a git failure is an empty scope, never a throw.
    return [];
  }
}

/**
 * Resolve the changed `.tsx` files for a run. Returns only `.tsx` paths (the
 * engine's static React surface); an empty array means "no diff context —
 * fall back to a wholesale scan", the same signal the shell encoded as an empty
 * `FILES`.
 */
export function scopeChangedTsx(input: DiffScopeInput): string[] {
  const explicit = input.changedFiles;
  if (explicit !== undefined && explicit.length > 0) {
    return explicit.filter((p) => TSX.test(p));
  }
  if (
    input.baseSha !== undefined &&
    input.baseSha !== "" &&
    input.headSha !== undefined &&
    input.headSha !== "" &&
    isGitRepo(input.workspace)
  ) {
    return gitDiffNames(input.workspace, input.baseSha, input.headSha).filter((p) => TSX.test(p));
  }
  return [];
}

/**
 * Resolve the scope from the CI environment (the Action's contract): reads the
 * same `CHANGED_FILES` / `BASE_SHA` / `HEAD_SHA` / `GITHUB_WORKSPACE` variables
 * the shell used, so the Action delegates its file-resolution here verbatim.
 */
export function scopeChangedTsxFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const rawChanged = env.CHANGED_FILES;
  return scopeChangedTsx({
    changedFiles: rawChanged !== undefined && rawChanged !== "" ? parseChangedFiles(rawChanged) : undefined,
    baseSha: env.BASE_SHA,
    headSha: env.HEAD_SHA,
    workspace: env.GITHUB_WORKSPACE ?? process.cwd(),
  });
}
