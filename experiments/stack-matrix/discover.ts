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
import { DESIGN_SYSTEMS, FRAMEWORK_TARGETS, OWN_MONOREPOS } from "./matrix.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SEED_PATH = join(HERE, "seed.json");
const MANIFEST_PATH = join(HERE, "manifest.json");

const SEARCH_LIMIT = 6; // candidates per design system from code search
const KEEP_PER_DS = 3; // survivors kept per design system after ranking
const MAX_DISK_KB = 200_000; // skip repos larger than this (too slow to scan)
const POLITE_SLEEP_MS = 7_000; // between code-search calls (~10 req/min budget)

// Framework discovery over-fetches (CRA/Gatsby skew to .jsx; the checker is
// TSX-only, so we cast a wider net and prefer TypeScript repos) and keeps fewer
// per framework — these only need to FILL a missing cell, not dominate it.
const FW_SEARCH_LIMIT = 8; // candidates per framework from code search
const KEEP_PER_FW = 2; // survivors kept per framework after ranking

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
  source: "seed" | "discovered" | "framework-discovered";
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

/** Run a raw `gh search code` query and return its deduped owner/name list. */
function searchCode(query: string, limit: number): string[] {
  try {
    const raw = gh(["search", "code", query, "--limit", String(limit), "--json", "repository"]);
    const rows = JSON.parse(raw) as Array<{ repository?: { nameWithOwner?: string } }>;
    const names = rows
      .map((r) => r.repository?.nameWithOwner)
      .filter((n): n is string => typeof n === "string");
    return [...new Set(names)];
  } catch (err) {
    console.warn(`  ! code-search failed for "${query}": ${(err as Error).message.split("\n")[0]}`);
    return [];
  }
}

/** Code-search for repos whose package.json declares `dep`. Returns owner/name list. */
function searchRepos(dep: string): string[] {
  return searchCode(`"${dep}" filename:package.json`, SEARCH_LIMIT);
}

/**
 * Count `.tsx` blobs in a pinned tree via the git-trees API. The checker is
 * TSX-only, so a repo with zero `.tsx` is useless to us — this lets the
 * framework pass PREFER TypeScript repos and drop pure-`.jsx` CRA/Gatsby apps
 * before they ever get cloned.
 */
function tsxCount(repo: string, sha: string): number {
  const [owner, name] = repo.split("/");
  try {
    const raw = gh([
      "api",
      `repos/${owner}/${name}/git/trees/${sha}?recursive=1`,
      "--jq",
      '[.tree[].path | select(endswith(".tsx"))] | length',
    ]);
    const n = Number.parseInt(raw, 10);
    return Number.isNaN(n) ? 0 : n;
  } catch {
    return 0;
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

  // ---- FRAMEWORK pass: fill cells the design-system search never surfaces. ----
  // We MERGE onto the design-system manifest (dedupe by repo) instead of
  // replacing it — the design-system picks are the spine, framework picks just
  // backfill the empty remix / cra / gatsby columns.
  const merged = await frameworkPass(manifest);

  writeFileSync(MANIFEST_PATH, JSON.stringify(merged, null, 2) + "\n");
  console.log(`\nWrote ${merged.length} pinned repos → ${MANIFEST_PATH}`);
}

/**
 * Discover repos by FRAMEWORK dep (TS-biased), filter + pin like the DS pass,
 * prefer repos that actually contain `.tsx`, and MERGE the survivors into the
 * given manifest. Idempotent: dedupes by repo name, so an entry already present
 * (from the DS pass or a prior framework run) is never duplicated.
 */
async function frameworkPass(base: ManifestEntry[]): Promise<ManifestEntry[]> {
  const seen = new Set(base.map((e) => e.repo.toLowerCase()));
  const additions: ManifestEntry[] = [];

  console.log("\n— framework pass —");
  for (let i = 0; i < FRAMEWORK_TARGETS.length; i++) {
    const fw = FRAMEWORK_TARGETS[i];
    const own = new Set(fw.own.map((s) => s.toLowerCase()));

    // Over-fetch, TS-biased.
    const candidates = searchCode(fw.tsHint, FW_SEARCH_LIMIT);

    // Filter + pin + measure .tsx, exactly like the DS pass but with a TSX gate.
    const survivors: Array<ManifestEntry & { tsx: number }> = [];
    for (const repo of candidates) {
      if (own.has(repo.toLowerCase())) continue; // skip the framework's own infra
      if (seen.has(repo.toLowerCase())) continue; // already in the manifest
      const meta = repoMeta(repo);
      if (!meta) continue; // 404 / moved
      if (meta.isArchived || meta.isFork) continue;
      if (meta.diskUsage > MAX_DISK_KB) continue; // too big to scan quickly
      const sha = pinSha(meta.nameWithOwner, meta.defaultBranch);
      if (!sha) continue; // could not pin
      const tsx = tsxCount(meta.nameWithOwner, sha);
      if (tsx === 0) continue; // TSX-only checker — pure-.jsx repos are useless
      survivors.push({
        repo: meta.nameWithOwner,
        designSystem: fw.key, // framework cell; detectFramework re-derives post-clone
        defaultBranch: meta.defaultBranch,
        sha,
        stars: meta.stars,
        source: "framework-discovered",
        tsx,
      });
    }

    // Prefer richer TSX repos, break ties by stars; keep the top N.
    survivors.sort((a, b) => b.tsx - a.tsx || b.stars - a.stars);
    const kept = survivors.slice(0, KEEP_PER_FW);
    for (const k of kept) {
      const { tsx: _tsx, ...entry } = k;
      additions.push(entry);
      seen.add(entry.repo.toLowerCase());
    }
    console.log(
      `${fw.key.padEnd(7)} kept ${kept.length}/${survivors.length} ` +
        `(searched=${candidates.length}) → ` +
        (kept.map((k) => `${k.repo}(tsx=${k.tsx})`).join(", ") || "none"),
    );

    if (i < FRAMEWORK_TARGETS.length - 1) await sleep(POLITE_SLEEP_MS);
  }

  return [...base, ...additions];
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
