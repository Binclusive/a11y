import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deletedPaths, parseChangedFiles, scopeChangedTsx } from "../src/diff-scope";

/**
 * Diff-scoping is the ONE shared module the engine and the CI Action import
 * (replacing the inline `git diff | grep` shell). It resolves WHICH .tsx files a
 * run scans, in priority order: explicit list, then a BASE..HEAD git diff.
 */

describe("parseChangedFiles", () => {
  it("splits a whitespace-separated list and drops empties", () => {
    expect(parseChangedFiles("a.tsx\n b.ts  c.tsx\n")).toEqual(["a.tsx", "b.ts", "c.tsx"]);
    expect(parseChangedFiles("")).toEqual([]);
  });
});

describe("scopeChangedTsx — explicit list (highest priority)", () => {
  it("keeps only .tsx paths", () => {
    expect(
      scopeChangedTsx({ changedFiles: ["a.tsx", "b.ts", "c/d.tsx", "e.css"], workspace: "/nope" }),
    ).toEqual(["a.tsx", "c/d.tsx"]);
  });

  it("returns [] when no diff context is available (fall back to wholesale scan)", () => {
    expect(scopeChangedTsx({ workspace: "/nope" })).toEqual([]);
    expect(scopeChangedTsx({ changedFiles: [], baseSha: "", headSha: "", workspace: "/nope" })).toEqual([]);
  });
});

describe("scopeChangedTsx — BASE..HEAD git diff", () => {
  let repo: string;
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "diff-scope-"));
    git("init", "-q");
    git("config", "user.email", "t@t.io");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "base.tsx"), "export const A = 1;\n");
    git("add", ".");
    git("commit", "-q", "-m", "base");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("returns the changed .tsx files between two commits, filtering non-tsx", () => {
    const base = git("rev-parse", "HEAD");
    writeFileSync(join(repo, "Added.tsx"), "export const B = 2;\n");
    writeFileSync(join(repo, "notes.md"), "# hi\n");
    git("add", ".");
    git("commit", "-q", "-m", "change");
    const head = git("rev-parse", "HEAD");

    expect(scopeChangedTsx({ baseSha: base, headSha: head, workspace: repo })).toEqual(["Added.tsx"]);
  });

  it("returns [] for a non-git workspace even with SHAs set", () => {
    expect(scopeChangedTsx({ baseSha: "x", headSha: "y", workspace: tmpdir() })).toEqual([]);
  });

  /**
   * Shallow-checkout regression (#198): when the merge-base commit is absent (the
   * defining trait of a shallow clone whose base was self-fetched at depth 1), the
   * three-dot `base...head` range fails "no merge base". The scoper MUST degrade to
   * the two-dot `base..head` tree comparison and still report the changed .tsx —
   * never swallow the error into an empty (silently-green) scope. Two disconnected
   * root commits (no common ancestor) reproduce the missing-merge-base condition.
   */
  it("falls back to two-dot when there is no merge base (shallow clone) and still finds the .tsx", () => {
    git("checkout", "-q", "--orphan", "baseline");
    writeFileSync(join(repo, "Widget.tsx"), "export const W = 1;\n");
    git("add", ".");
    git("commit", "-q", "-m", "orphan base");
    const base = git("rev-parse", "HEAD");

    git("checkout", "-q", "--orphan", "topic");
    // A fresh orphan tree with a DIFFERENT .tsx content — no shared history, so
    // `base...head` has no merge base, exactly like a shallow-fetched base.
    writeFileSync(join(repo, "Widget.tsx"), "export const W = 2;\n");
    git("add", ".");
    git("commit", "-q", "-m", "orphan head");
    const head = git("rev-parse", "HEAD");

    // Sanity: three-dot really is broken here (the condition we degrade from).
    expect(() =>
      execFileSync("git", ["-C", repo, "diff", "--name-only", `${base}...${head}`], { stdio: "ignore" }),
    ).toThrow();

    expect(scopeChangedTsx({ baseSha: base, headSha: head, workspace: repo })).toEqual(["Widget.tsx"]);
  });
});

/**
 * `deletedPaths` = TRUE deletions only (ADR 0043 v2). Rename detection is pinned ON
 * (`--find-renames`/`-M`) so a MOVE is classified `R` and its old path is EXCLUDED —
 * the false-resolve hole a renamed file's old path would otherwise open.
 */
describe("deletedPaths — true deletions, renames excluded", () => {
  let repo: string;
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "deleted-paths-"));
    git("init", "-q");
    git("config", "user.email", "t@t.io");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "renameme.tsx"), "export const R = 1;\n");
    writeFileSync(join(repo, "deleteme.tsx"), "export const D = 2;\n");
    git("add", ".");
    git("commit", "-q", "-m", "base");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("includes a genuinely deleted file, EXCLUDES a renamed file's old path", () => {
    const base = git("rev-parse", "HEAD");
    // A rename (git mv → content moved, not gone) and a true deletion (content gone).
    git("mv", "renameme.tsx", "renamed.tsx");
    rmSync(join(repo, "deleteme.tsx"));
    git("add", "-A");
    git("commit", "-q", "-m", "change");
    const head = git("rev-parse", "HEAD");

    const deleted = deletedPaths({ baseSha: base, headSha: head, workspace: repo });
    // The true deletion IS reported…
    expect(deleted).toContain("deleteme.tsx");
    // …the rename's OLD path is NOT (it moved, it isn't gone) — the -M pin.
    expect(deleted).not.toContain("renameme.tsx");
    expect(deleted).not.toContain("renamed.tsx");
  });

  it("returns [] with no base ref (full scan — never a fabricated deletion)", () => {
    expect(deletedPaths({ workspace: repo })).toEqual([]);
    expect(deletedPaths({ baseSha: "", headSha: "", workspace: repo })).toEqual([]);
  });

  it("returns [] for a non-git workspace even with SHAs set", () => {
    expect(deletedPaths({ baseSha: "x", headSha: "y", workspace: tmpdir() })).toEqual([]);
  });
});
