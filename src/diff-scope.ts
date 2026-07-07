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

/**
 * Names touched between base and head, honoring extra diff flags (deletion
 * filter, rename detection).
 *
 * Prefers the THREE-dot `base...head` range — the PR-diff semantic GitHub's own
 * PR view uses (changes since the merge-base, excluding commits added to base
 * after the branch point). On a SHALLOW checkout the merge-base commit is usually
 * absent, so three-dot fails hard with "no merge base" (#198). Rather than swallow
 * that as an empty scope — the silent-empty-green trap: 0 files → 0 findings → a
 * GREEN check on a scan that saw NOTHING — degrade to the TWO-dot `base..head`
 * tree comparison, which needs only the two endpoint commits (both guaranteed
 * present — `entrypoint.sh` self-fetches the base before scoping). Two-dot is a
 * strict superset of the three-dot change set, so it can only OVER-scan (extra
 * files a drifted base changed), never HIDE a PR-touched file — the safe
 * direction for an advisory gate.
 */
function gitDiffRange(
  workspace: string,
  baseSha: string,
  headSha: string,
  extraArgs: readonly string[],
): string[] {
  const run = (range: string): string =>
    execFileSync("git", ["-C", workspace, "diff", ...extraArgs, "--name-only", range], {
      encoding: "utf8",
    });
  let out: string;
  try {
    out = run(`${baseSha}...${headSha}`);
  } catch {
    try {
      out = run(`${baseSha}..${headSha}`);
    } catch {
      // Advisory gate: both ranges failed (e.g. head unresolvable) is an empty
      // scope, never a throw. A missing BASE is caught earlier, and loud, in
      // entrypoint.sh — this path never sees a bad base.
      return [];
    }
  }
  return out.split("\n").filter((p) => p !== "");
}

function gitDiffNames(workspace: string, baseSha: string, headSha: string): string[] {
  return gitDiffRange(workspace, baseSha, headSha, []);
}

/**
 * The TRUE deletions in a diff — files whose content is GONE, never MOVED.
 *
 * `--diff-filter=D` selects deleted entries; `--find-renames` (`-M`) is pinned ON
 * EXPLICITLY (never left to git's config/context-dependent default) so a MOVE
 * classifies as `R` and its old path is EXCLUDED — a rename is not a deletion. This
 * closes a false-resolve hole (ADR 0043 v2): a renamed file's old path must NOT be
 * reported deleted, or a move out of scan-scope silently vanishes its finding.
 * Paths are repo-root-relative, forward-slash (git's native output).
 */
function gitDeletedNames(workspace: string, baseSha: string, headSha: string): string[] {
  return gitDiffRange(workspace, baseSha, headSha, ["--diff-filter=D", "--find-renames"]);
}

/**
 * Resolve the source files DELETED in this run's diff (ADR 0043 v2 — the
 * `deletedPaths` coverage half). A deleted-file's source ticket resolves because the
 * code — and so the issue — is gone. Derived ONLY from a real `BASE...HEAD` git diff:
 * an explicit `CHANGED_FILES` name list cannot classify deleted-vs-added, and a full
 * scan (no base ref) has no deletion context, so both yield `[]` — never a fabricated
 * deletion (the safe direction: under-report, never over-report).
 */
export function deletedPaths(input: DiffScopeInput): string[] {
  if (
    input.baseSha !== undefined &&
    input.baseSha !== "" &&
    input.headSha !== undefined &&
    input.headSha !== "" &&
    isGitRepo(input.workspace)
  ) {
    return gitDeletedNames(input.workspace, input.baseSha, input.headSha);
  }
  return [];
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

/**
 * Resolve the run's TRUE deletions from the CI env — the sibling of
 * {@link scopeChangedTsxFromEnv} for the `deletedPaths` coverage half. Reads the same
 * `BASE_SHA` / `HEAD_SHA` / `GITHUB_WORKSPACE` the diff-scope uses; with no base ref
 * it yields `[]` (never a fabricated deletion).
 */
export function deletedPathsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return deletedPaths({
    baseSha: env.BASE_SHA,
    headSha: env.HEAD_SHA,
    workspace: env.GITHUB_WORKSPACE ?? process.cwd(),
  });
}
