import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseChangedFiles, scopeChangedTsx } from "../src/diff-scope";

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
});
