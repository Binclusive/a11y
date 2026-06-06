/**
 * discover.ts — LIVE discovery → pinned manifest.
 *
 * For each design system, code-search GitHub for package.json files that
 * declare the design system's npm package, merge in the curated seed, filter
 * out junk (archived / forks / own-monorepo / too-big), rank survivors by
 * stars, keep the top 3, PIN each to a commit SHA, and write manifest.json.
 *
 * The manifest is the reproducible contract: `run.ts` clones exactly what is
 * pinned here. Re-running `discover` overwrites manifest.json (idempotent) —
 * picks can drift as GitHub's index / star counts change, which is why we pin.
 *
 * Politeness: GitHub code search is ~10 req/min. We sleep ~7s between design
 * systems. Repo-meta calls (`gh repo view`) are cheaper REST and are not
 * throttled here beyond their natural latency.
 */

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DESIGN_SYSTEMS, OWN_MONOREPOS } from "./matrix.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SEED_PATH = join(HERE, "seed.json");
const MANIFEST_PATH = join(HERE, "manifest.json");

const SEARCH_LIMIT = 6; // candidates per design system from code search
const KEEP_PER_DS = 3; // survivors kept per design system after ranking
const MAX_DISK_KB = 200_000; // skip repos larger than this (too slow to scan)
const POLITE_SLEEP_MS = 7_000; // between code-search calls (~10 req/min budget)

interface SeedEntry {
  repo: string;
  designSystem: string;
}

interface ManifestEntry {
  repo: string;
  designSystem: string;
  defaultBranch: string;
  sha: string;
  stars: number;
  source: "seed" | "discovered";
}

interface RepoMeta {
  nameWithOwner: string;
  defaultBranch: string;
  stars: number;
  diskUsage: number;
  isArchived: boolean;
  isFork: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run `gh` and return trimmed stdout; throw on non-zero. */
function gh(args: string[]): string {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).trim();
}

/** Code-search for repos whose package.json declares `dep`. Returns owner/name list. */
function searchRepos(dep: string): string[] {
  try {
    const raw = gh([
      "search",
      "code",
      `"${dep}" filename:package.json`,
      "--limit",
      String(SEARCH_LIMIT),
      "--json",
      "repository",
    ]);
    const rows = JSON.parse(raw) as Array<{ repository?: { nameWithOwner?: string } }>;
    const names = rows
      .map((r) => r.repository?.nameWithOwner)
      .filter((n): n is string => typeof n === "string");
    return [...new Set(names)];
  } catch (err) {
    console.warn(`  ! code-search failed for "${dep}": ${(err as Error).message.split("\n")[0]}`);
    return [];
  }
}

/** Fetch repo meta, or null if the repo is gone / inaccessible. */
function repoMeta(repo: string): RepoMeta | null {
  try {
    const raw = gh([
      "repo",
      "view",
      repo,
      "--json",
      "nameWithOwner,defaultBranchRef,stargazerCount,diskUsage,isArchived,isFork",
    ]);
    const j = JSON.parse(raw) as {
      nameWithOwner: string;
      defaultBranchRef?: { name?: string };
      stargazerCount: number;
      diskUsage: number;
      isArchived: boolean;
      isFork: boolean;
    };
    return {
      nameWithOwner: j.nameWithOwner,
      defaultBranch: j.defaultBranchRef?.name ?? "main",
      stars: j.stargazerCount ?? 0,
      diskUsage: j.diskUsage ?? 0,
      isArchived: j.isArchived,
      isFork: j.isFork,
    };
  } catch {
    return null;
  }
}

/** Pin the current HEAD sha of `branch` on `repo`, or null. */
function pinSha(repo: string, branch: string): string | null {
  const [owner, name] = repo.split("/");
  try {
    return gh(["api", `repos/${owner}/${name}/commits/${branch}`, "--jq", ".sha"]);
  } catch {
    return null;
  }
}

async function main() {
  const seed = JSON.parse(
    execFileSync("cat", [SEED_PATH], { encoding: "utf8" }),
  ) as SeedEntry[];

  // Group seed entries by design system for quick merge.
  const seedByDs = new Map<string, Set<string>>();
  for (const s of seed) {
    if (!seedByDs.has(s.designSystem)) seedByDs.set(s.designSystem, new Set());
    seedByDs.get(s.designSystem)!.add(s.repo);
  }

  const manifest: ManifestEntry[] = [];

  for (let i = 0; i < DESIGN_SYSTEMS.length; i++) {
    const ds = DESIGN_SYSTEMS[i];
    const own = new Set((OWN_MONOREPOS[ds.key] ?? []).map((s) => s.toLowerCase()));

    // 1. Discovered candidates (union across this DS's deps).
    const discovered = new Set<string>();
    for (const dep of ds.deps) {
      for (const r of searchRepos(dep)) discovered.add(r);
    }

    // 2. Merge in seed repos, tracking provenance.
    const seedRepos = seedByDs.get(ds.key) ?? new Set<string>();
    const sourceOf = new Map<string, "seed" | "discovered">();
    for (const r of discovered) sourceOf.set(r, "discovered");
    for (const r of seedRepos) sourceOf.set(r, "seed"); // seed wins provenance

    // 3. Filter + fetch meta + pin.
    const survivors: ManifestEntry[] = [];
    for (const repo of sourceOf.keys()) {
      if (own.has(repo.toLowerCase())) continue; // skip the DS's own monorepo
      const meta = repoMeta(repo);
      if (!meta) continue; // 404 / moved
      if (meta.isArchived || meta.isFork) continue;
      if (meta.diskUsage > MAX_DISK_KB) continue; // too big to scan quickly
      const sha = pinSha(meta.nameWithOwner, meta.defaultBranch);
      if (!sha) continue; // could not pin
      survivors.push({
        repo: meta.nameWithOwner,
        designSystem: ds.key,
        defaultBranch: meta.defaultBranch,
        sha,
        stars: meta.stars,
        source: sourceOf.get(repo) ?? "discovered",
      });
    }

    // 4. Rank by stars, keep top N — but always keep seed entries.
    survivors.sort((a, b) => b.stars - a.stars);
    const seedSurvivors = survivors.filter((s) => s.source === "seed");
    const ranked = survivors.filter((s) => s.source !== "seed").slice(0, KEEP_PER_DS);
    const kept = [...seedSurvivors];
    for (const r of ranked) {
      if (kept.length >= KEEP_PER_DS && seedSurvivors.length === 0) break;
      if (!kept.some((k) => k.repo === r.repo)) kept.push(r);
    }
    // Cap total per DS at KEEP_PER_DS unless seeds push it over.
    const final = kept.slice(0, Math.max(KEEP_PER_DS, seedSurvivors.length));

    manifest.push(...final);
    console.log(
      `${ds.key.padEnd(11)} kept ${final.length}  ` +
        `(discovered=${discovered.size}, seed=${seedRepos.size}) → ` +
        final.map((f) => f.repo).join(", ") || `${ds.key}: none`,
    );

    if (i < DESIGN_SYSTEMS.length - 1) await sleep(POLITE_SLEEP_MS);
  }

  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`\nWrote ${manifest.length} pinned repos → ${MANIFEST_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
